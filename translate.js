// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // 【新增】引入 Gemini
const pluralize = require('pluralize');
const fs = require('fs');
const path = require('path');

// --- 【配置常量】 ---
const BASE_URL = 'https://en.tankiwiki.com';
const START_PAGE = 'Tanki_Online_Wiki';
const RECENT_CHANGES_FEED_URL = 'https://en.tankiwiki.com/api.php?action=feedrecentchanges&days=7&feedformat=atom&urlversion=1';
const CONCURRENCY_LIMIT = 1; // 【修改】为了适应 Gemini 免费版（15次/分钟）的并发限制，改为 1
const DICTIONARY_URL = 'https://testanki1.github.io/translations.js';
const SOURCE_DICT_FILE = 'source_replacements.js';
const OUTPUT_DIR = './output';
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');
const REDIRECT_MAP_FILE = path.join(__dirname, 'redirect_map.json');

// 初始化 Gemini 客户端
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
// 【修改】指定使用用户要求的模型
const geminiModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

const sanitizePageName = (name) => name.replaceAll(' ', '_');

// [解析 Feed，与之前相同]
async function getPagesForFeedMode(lastEditInfo) {
    console.log(`[更新模式] 正在从 ${RECENT_CHANGES_FEED_URL} 获取最近更新...`);
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.goto(RECENT_CHANGES_FEED_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        let responseText = await page.content();
        
        const $html = cheerio.load(responseText);
        const xmlContainer = $html('#webkit-xml-viewer-source-xml');
        let feedXml = xmlContainer.length ? xmlContainer.html() : responseText;
        feedXml = feedXml.replace(/xmlns="[^"]*"/g, '');

        const $ = cheerio.load(feedXml, { xmlMode: true, decodeEntities: false });
        const entries = $('entry');

        if (entries.length === 0) return[];

        const pagesToConsider = new Map();
        entries.each((i, entry) => {
            const $entry = $(entry);
            const title = sanitizePageName($entry.find('title').first().text());
            let alternateLink = null;
            $entry.find('link').each(function() {
                if ($(this).attr('rel') === 'alternate') { alternateLink = $(this).attr('href'); return false; }
            });
            if (title && alternateLink) {
                const diffMatch = alternateLink.match(/diff=(\d+)/);
                const newRevisionId = diffMatch && diffMatch[1] ? parseInt(diffMatch[1], 10) : null;
                if (newRevisionId && (!pagesToConsider.has(title) || newRevisionId > pagesToConsider.get(title))) {
                    pagesToConsider.set(title, newRevisionId);
                }
            }
        });

        const pagesToUpdate =[];
        for (const [title, newRevisionId] of pagesToConsider.entries()) {
            const blockedPrefixes = ['Special:', 'User:', 'MediaWiki:', 'Help:', 'Category:', 'File:', 'Template:'];
            if (blockedPrefixes.some(p => title.startsWith(p))) continue;
            
            const currentRevisionId = lastEditInfo[title] || 0;
            if (newRevisionId > currentRevisionId) {
                pagesToUpdate.push(title);
            }
        }
        return pagesToUpdate;
    } catch (error) {
        console.error('❌ [更新模式] 处理 Feed 时出错:', error.message);
        return[];
    } finally {
        if (browser) await browser.close();
    }
}

async function getPreparedDictionary() { 
    console.log(`正在从 URL 获取文本词典: ${DICTIONARY_URL}`); 
    let originalDict; 
    try { 
        const response = await fetch(DICTIONARY_URL); 
        if (!response.ok) throw new Error(`网络请求失败: ${response.status}`); 
        const scriptContent = await response.text(); 
        originalDict = new Function(`${scriptContent}; return replacementDict;`)(); 
    } catch (error) { 
        return { fullDictionary: new Map(), sortedKeys:[] }; 
    } 
    const tempDict = { ...originalDict }; 
    for (const key in originalDict) { 
        if (Object.hasOwnProperty.call(originalDict, key)) { 
            const pluralKey = pluralize(key); 
            if (pluralKey !== key && !tempDict.hasOwnProperty(pluralKey)) tempDict[pluralKey] = originalDict[key]; 
        } 
    } 
    const fullDictionary = new Map(Object.entries(tempDict)); 
    const sortedKeys = Object.keys(tempDict).sort((a, b) => b.length - a.length); 
    return { fullDictionary, sortedKeys }; 
}

function getPreparedSourceDictionary() {
    const filePath = path.resolve(__dirname, SOURCE_DICT_FILE);
    if (!fs.existsSync(filePath)) return new Map();
    try {
        const scriptContent = fs.readFileSync(filePath, 'utf-8');
        const sourceDict = new Function(`${scriptContent}; return sourceReplacementDict;`)();
        return new Map(Object.entries(sourceDict || {}));
    } catch (error) { return new Map(); }
}

function replaceTermsDirectly(text, fullDictionary, sortedKeys) { 
    if (!text) return ""; 
    let result = text; 
    for (const key of sortedKeys) { 
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
        const regex = new RegExp(`\\b${escapedKey}\\b`, 'gi'); 
        if (regex.test(result)) result = result.replace(regex, fullDictionary.get(key)); 
    } 
    return result; 
}

function containsEnglish(text) { return /[a-zA-Z]/.test(text); }

// 【核心修改】废除繁杂的分词机翻，使用批量发送给 Gemini
async function translateBatchWithGemini(texts) {
    if (!texts || texts.length === 0) return[];
    if (!process.env.GEMINI_API_KEY) {
        console.warn("⚠️ 未配置 GEMINI_API_KEY，将跳过机翻。");
        return texts;
    }

    const results = new Array(texts.length);
    const batchSize = 30; // 每次打包 30 个字符串发送，保障上下文并不超载 JSON
    
    // 只挑选含有英文的文本进行机翻
    const tasksToTranslate =[];
    for (let i = 0; i < texts.length; i++) {
        if (containsEnglish(texts[i])) {
            tasksToTranslate.push({ index: i, text: texts[i] });
        } else {
            results[i] = texts[i];
        }
    }

    for (let i = 0; i < tasksToTranslate.length; i += batchSize) {
        const batchObj = tasksToTranslate.slice(i, i + batchSize);
        const batchTexts = batchObj.map(t => t.text);
        
        const prompt = `你是一个专业的游戏维基翻译。请将以下JSON数组中的文本翻译为简体中文。
注意：文本中可能已经包含了一些预先翻译好的中文术语，请保留这些术语并将其流畅地融入最终的中文翻译中。不要遗漏任何HTML符号、大括号或标点符号。
要求：
1. 返回且仅返回一个合法的JSON数组，禁止使用markdown（如 \`\`\`json ），直接输出[] 包裹的数据，数组长度必须严格为 ${batchTexts.length}。
2. 保持原有的前后空格、标点符号风格。如果原文只是单独的代码或无意义字符请原样保留。

待翻译的JSON数组：
${JSON.stringify(batchTexts)}
`;
        let batchResult = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await geminiModel.generateContent(prompt);
                const text = response.response.text();
                // 贪婪匹配提取返回内容中的 JSON
                const jsonMatch = text.match(/\[\s*[\s\S]*\s*\]/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed) && parsed.length === batchTexts.length) {
                        batchResult = parsed;
                        break;
                    }
                }
            } catch (err) {
                console.warn(`[Gemini 翻译尝试 ${attempt}/3] 失败: ${err.message}`);
            }
            if (!batchResult && attempt < 3) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        
        // 填入最终结果
        const finalBatch = batchResult || batchTexts; // 如果最终失败，保留原文本
        batchObj.forEach((obj, idx) => {
            results[obj.index] = finalBatch[idx];
        });

        // 加入强制延时，避免频繁请求触发 Gemini 的 429 限制 (15 requests/min)
        if (i + batchSize < tasksToTranslate.length) {
            await new Promise(r => setTimeout(r, 4000));
        }
    }
    
    return results;
}

function getPageNameFromWikiLink(href) { 
    if (!href) return null; let url; try { url = new URL(href, BASE_URL); } catch (e) { return null; } 
    if (url.hostname !== new URL(BASE_URL).hostname) return null; 
    let pathname = decodeURIComponent(url.pathname); if (pathname.startsWith('/w/index.php')) return null; 
    let pageName = pathname.substring(1); 
    const blockedPrefixes = ['Special', 'File', 'User', 'MediaWiki', 'Template', 'Help', 'Category']; 
    const blockedPrefixRegex = new RegExp(`^(${blockedPrefixes.join('|')}):`, 'i'); 
    if (!pageName || blockedPrefixRegex.test(pageName) || pageName.includes('#') || /\.(css|js|png|jpg|jpeg|gif|svg|ico|php)$/i.test(pageName)) return null; 
    return sanitizePageName(pageName); 
}

function findInternalLinks($) { 
    const links = new Set(); 
    $('#mw-content-text a[href]').each((i, el) => { 
        const pageName = getPageNameFromWikiLink($(el).attr('href')); 
        if (pageName) links.add(pageName); 
    }); 
    return Array.from(links); 
}

function createRedirectHtml(targetPageName) { 
    const targetUrl = `./${targetPageName}`; return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>正在重定向...</title><meta http-equiv="refresh" content="0; url=${targetUrl}"><link rel="canonical" href="${targetUrl}"><script>window.location.replace("${targetUrl}");</script></head><body><p>如果您的浏览器没有自动跳转，请 <a href="${targetUrl}">点击这里</a>。</p></body></html>`; 
}

function findImageReplacement(url, replacementMap) {
    if (!url) return url;
    if (replacementMap.has(url)) return replacementMap.get(url);
    const thumbRegex = /(.*\/images\/\w{2})\/thumb(\/.*?\.\w+)\/\d+px-.*$/i;
    const match = url.match(thumbRegex);
    if (match && match[1] && match[2]) {
        const reconstructedBaseUrl = match[1] + match[2];
        if (replacementMap.has(reconstructedBaseUrl)) return replacementMap.get(reconstructedBaseUrl);
    }
    return url;
}

async function processPage(pageNameToProcess, fullDictionary, sortedKeys, sourceReplacementMap, lastEditInfoState, force = false) {
    const sourceUrl = `${BASE_URL}/${pageNameToProcess}`;
    console.log(`[${pageNameToProcess}] 开始抓取页面: ${sourceUrl}`);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    let htmlContent;

    try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForSelector('#mw-content-text', { timeout: 0 });
        htmlContent = await page.content();
    } catch (error) {
        console.error(`[${pageNameToProcess}] 抓取或等待页面内容时发生错误: ${error.message}`);
        await browser.close();
        return null;
    } finally {
        await browser.close();
    }
    
    const $ = cheerio.load(htmlContent);
    let rlconf = null;
    const rlconfMatch = htmlContent.match(/RLCONF\s*=\s*(\{[\s\S]*?\});/);
    if (rlconfMatch && rlconfMatch[1]) {
        try { rlconf = JSON.parse(rlconfMatch[1]); } catch (e) { rlconf = null; }
    }

    if (!rlconf) return null;
    if (rlconf.wgArticleId === 0) return { links:[] };
    if (rlconf.wgRedirectedFrom && rlconf.wgPageName !== rlconf.wgRedirectedFrom) {
        const sourcePage = sanitizePageName(rlconf.wgRedirectedFrom);
        const targetPage = sanitizePageName(rlconf.wgPageName);
        fs.writeFileSync(path.join(OUTPUT_DIR, `${sourcePage}.html`), createRedirectHtml(targetPage), 'utf-8');
        return { isRedirect: true, newRedirectInfo: { source: sourcePage, target: targetPage }, links: findInternalLinks($) };
    }

    const currentEditInfo = rlconf.wgCurRevisionId || rlconf.wgRevisionId || null;
    if (!force && currentEditInfo && lastEditInfoState[pageNameToProcess] === currentEditInfo) {
        console.log(`[${pageNameToProcess}] 页面未更改。跳过。`);
        return { links: findInternalLinks($) };
    }

    const headElements =[];
    $('head').children('link, style, script, meta, title').each(function() {
        const $el = $(this);
        if ($el.is('link') && $el.attr('href')?.startsWith('/')) $el.attr('href', BASE_URL + $el.attr('href'));
        if ($el.is('script') && $el.attr('src')?.startsWith('/')) $el.attr('src', BASE_URL + $el.attr('src'));
        if ($el.is('meta') && $el.attr('content')) $el.attr('content', findImageReplacement($el.attr('content'), sourceReplacementMap));
        headElements.push($.html(this));
    });

    const bodyEndScripts =[]; $('body > script').each(function() { const $el = $(this); if ($el.attr('src')?.startsWith('/')) $el.attr('src', BASE_URL + $el.attr('src')); bodyEndScripts.push($.html(this)); });
    
    const $contentContainer = $('<div id="wiki-content-wrapper"></div>'); 
    $('#firstHeading').clone().appendTo($contentContainer); 
    $('#mw-content-text .mw-parser-output').children().each(function() { $contentContainer.append($(this).clone()); });
    
    const $factBoxContent = $contentContainer.find('.random-text-box > div:last-child'); 
    if ($factBoxContent.length > 0) { 
        $factBoxContent.html('<p id="dynamic-fact-placeholder" style="margin:0;">正在加载有趣的事实...</p>'); 
        bodyEndScripts.push(`<script>document.addEventListener('DOMContentLoaded', function() { fetch('./facts.json').then(r=>r.json()).then(f=>{ document.getElementById('dynamic-fact-placeholder').innerHTML = f[Math.floor(Math.random() * f.length)].cn; }).catch(()=>console.error('Fact Load Failed')); });<\/script>`); 
    }

    $contentContainer.find('a').each(function() { 
        const $el = $(this); const href = $el.attr('href'); const internalName = getPageNameFromWikiLink(href); 
        if (internalName) $el.attr('href', `./${internalName}`); 
        else if (href && !href.startsWith('#')) try { $el.attr('href', new URL(href, sourceUrl).href); } catch (e) {} 
    });
    
    $contentContainer.find('img, iframe').each(function() {
        const $el = $(this); let src = $el.attr('src');
        if (src) {
            try { $el.attr('src', findImageReplacement(new URL(src, sourceUrl).href, sourceReplacementMap)); } catch (e) {}
        }
        if ($el.is('img') && $el.attr('srcset')) {
            $el.attr('srcset', $el.attr('srcset').split(',').map(s => {
                const parts = s.trim().split(/\s+/);
                try { return findImageReplacement(new URL(parts[0], sourceUrl).href, sourceReplacementMap) + (parts[1] ? ` ${parts[1]}` : ''); } catch(e) { return s; }
            }).join(', '));
        }
    });

    $contentContainer.find('.ShowYouTubePopup[data-id]').each(function() {
        const $el = $(this); const yid = $el.attr('data-id'); if (!yid) return;
        if (sourceReplacementMap.has(yid)) $el.attr('data-id', sourceReplacementMap.get(yid));
        else if (sourceReplacementMap.has(`https://www.youtube.com/embed/${yid}`)) {
            try { $el.attr('data-id', new URL(sourceReplacementMap.get(`https://www.youtube.com/embed/${yid}`)).searchParams.get('bvid') || yid); } catch (e) {}
        }
    });
    
    // 【核心修改】提取整个页面上所有需要翻译的内容，采用任务队列方式统一处理
    const translationTasks =[];
    let translatedTitle = $('title').text() || pageNameToProcess;

    // 1. 提取页面标题
    translationTasks.push({
        original: translatedTitle,
        setter: (val) => { translatedTitle = val.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3'); }
    });

    // 2. 提取需要翻译的 DOM 文本节点
    $contentContainer.find('*:not(script,style)').addBack().contents().each(function() { 
        if (this.type === 'text' && this.data.trim() && !$(this).parent().is('span.hotkey')) { 
            translationTasks.push({
                original: this.data,
                setter: (val) => { this.data = val.trim(); } // 将翻译完的内容插回
            });
        } 
    });

    // 3. 提取具有 title 或 alt 属性的文本
    $contentContainer.find('[title], [alt]').each(function() { 
        const $element = $(this); 
        for (const attr of ['title', 'alt']) { 
            const originalValue = $element.attr(attr); 
            if (originalValue) { 
                translationTasks.push({
                    original: originalValue,
                    setter: (val) => { $element.attr(attr, val); }
                });
            } 
        } 
    });

    // 将这些文本先用本地词库作替换（保证强一致性），然后发给 Gemini
    console.log(`[${pageNameToProcess}] 准备通过 Gemini 批量翻译 ${translationTasks.length} 个文本片段...`);
    const preReplacedTexts = translationTasks.map(t => replaceTermsDirectly(t.original, fullDictionary, sortedKeys));
    const translatedResults = await translateBatchWithGemini(preReplacedTexts);

    // 将翻译结果写回 DOM
    translationTasks.forEach((task, idx) => {
        task.setter(translatedResults[idx]);
    });
    
    let finalHtmlContent = $contentContainer.html().replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3');

    let homeButtonHtml = pageNameToProcess !== START_PAGE ? `<a href="./${START_PAGE}" style="display: inline-block; margin: 0 0 25px 0; padding: 12px 24px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.2);">返回主页</a>` : '';
    
    const colorReplacementScript = `<script>function replaceColorsInDom() { const replacements =[{ from: /#?46DF11|rgb\\(70,\\s*223,\\s*17\\)/gi, to: '#76FF33' }, { from: /#?00D7FF/gi, to: '#00D4FF' }, { from: /#?(F86667|F33|FF3333)\\b/gi, to: '#FF6666' }, { from: /#?(FC0|FFCC00)\\b/gi, to: '#FFEE00' }, { from: /#?8C60EB/gi, to: '#D580FF' }]; function applyReplacements(text) { if (!text) return text; let newText = text; for (const rule of replacements) newText = newText.replace(rule.from, rule.to); return newText; } document.querySelectorAll('[style]').forEach(el => { const orig = el.getAttribute('style'); const ns = applyReplacements(orig); if (ns !== orig) el.setAttribute('style', ns); }); document.querySelectorAll('style').forEach(tag => { const orig = tag.innerHTML; const ns = applyReplacements(orig); if (ns !== orig) tag.innerHTML = ns; }); } document.addEventListener('DOMContentLoaded', replaceColorsInDom);<\/script>`;
    bodyEndScripts.push(colorReplacementScript);

    const bilibiliPopupScript = `<script>document.addEventListener('DOMContentLoaded', function() { document.querySelectorAll('.ShowYouTubePopup').forEach(popup => { if (popup.dataset.biliHandled) return; popup.addEventListener('click', (e) => { e.stopImmediatePropagation(); if (typeof tingle === 'undefined') return; let modal = new tingle.modal({ closeMethods: ['button', 'escape', 'overlay'] }); modal.setContent(\`<div class="report-head"><div class="report-title">观看视频</div><div class="report-close"></div></div><div style="margin: 15px 10px 10px 10px;"><iframe class="yt-video" width="640px" height="360px" src="https://player.bilibili.com/player.html?bvid=\${popup.dataset.id}" frameborder="0" allowfullscreen="allowfullscreen"></iframe></div>\`); modal.open(); modal.getContent().querySelector('.report-close').addEventListener('click', () => modal.close()); }, true); popup.dataset.biliHandled = 'true'; }); });<\/script>`;
    bodyEndScripts.push(bilibiliPopupScript);
    
    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    '); 
    const finalHtml = `<!DOCTYPE html><html lang="zh-CN" dir="ltr"><head><meta charset="UTF-8"><title>${translatedTitle}</title>${headContent}<style>@import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');body{font-family:'Rubik','M PLUS 1p',sans-serif;background-color:#001926 !important;}#mw-main-container{max-width:1200px;margin:20px auto;background-color:#001926;padding:20px;}</style></head><body class="${$('body').attr('class') || ''}"><div id="mw-main-container">${homeButtonHtml}<div class="main-content"><div class="mw-body" id="content"><a id="top"></a><div class="mw-body-content"><div id="mw-content-text" class="mw-parser-output" lang="zh-CN" dir="ltr">${finalHtmlContent}</div></div></div></div></div>${bodyEndScripts.join('\n    ')}</body></html>`;
    
    fs.writeFileSync(path.join(OUTPUT_DIR, `${pageNameToProcess}.html`), finalHtml, 'utf-8');
    console.log(`✅[${pageNameToProcess}] 翻译完成！`);
    return { translationResult: { pageName: pageNameToProcess, newEditInfo: currentEditInfo }, links: findInternalLinks($) };
}

async function run() {
    console.log("--- 翻译任务开始 (Gemini 版本) ---");
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

    const sourceReplacementMap = getPreparedSourceDictionary();
    const { fullDictionary, sortedKeys } = await getPreparedDictionary();
    
    let lastEditInfo = {}, redirectMap = {};
    if (fs.existsSync(EDIT_INFO_FILE)) try { lastEditInfo = JSON.parse(fs.readFileSync(EDIT_INFO_FILE, 'utf-8')); } catch (e) {}
    if (fs.existsSync(REDIRECT_MAP_FILE)) try { redirectMap = JSON.parse(fs.readFileSync(REDIRECT_MAP_FILE, 'utf-8')); } catch (e) {}

    const runMode = (process.env.RUN_MODE || 'FEED').toUpperCase();
    let pagesToVisit =[];

    switch (runMode) {
        case 'FEED': pagesToVisit = await getPagesForFeedMode(lastEditInfo); break;
        case 'CRAWLER': pagesToVisit = [START_PAGE]; break;
        case 'SPECIFIED':
            pagesToVisit = (process.env.PAGES_TO_PROCESS || '').split(',').map(p => sanitizePageName(p.trim())).filter(Boolean);
            break;
    }

    if (pagesToVisit.length === 0) return console.log("没有需要处理的页面，任务提前结束。");
    
    const visitedPages = new Set();
    let activeTasks = 0, pageIndex = 0;
    const isForceMode = runMode === 'FEED' || runMode === 'SPECIFIED';

    while (pageIndex < pagesToVisit.length) {
        const promises =[];
        while (activeTasks < CONCURRENCY_LIMIT && pageIndex < pagesToVisit.length) {
            const currentPageName = pagesToVisit[pageIndex++];
            if (visitedPages.has(currentPageName)) continue;
            
            visitedPages.add(currentPageName);
            activeTasks++;

            const task = processPage(currentPageName, fullDictionary, sortedKeys, sourceReplacementMap, lastEditInfo, isForceMode)
                .then(result => {
                    if (result) {
                        if (result.newRedirectInfo) redirectMap[result.newRedirectInfo.source] = result.newRedirectInfo.target;
                        if (result.translationResult) lastEditInfo[result.translationResult.pageName] = result.translationResult.newEditInfo;
                        if (runMode === 'CRAWLER' && result.links) {
                            for (const link of result.links) if (!visitedPages.has(link) && !pagesToVisit.includes(link)) pagesToVisit.push(link);
                        }
                    }
                }).catch(err => console.error(`处理页面出错:`, err)).finally(() => activeTasks--);
            promises.push(task);
        }
        await Promise.all(promises);
    }

    try {
        fs.writeFileSync(EDIT_INFO_FILE, JSON.stringify(lastEditInfo, null, 2), 'utf-8');
        fs.writeFileSync(REDIRECT_MAP_FILE, JSON.stringify(redirectMap, null, 2), 'utf-8');
    } catch (e) {}
    console.log("--- 所有页面处理完毕，任务结束！ ---");
}

run().catch(console.error);
