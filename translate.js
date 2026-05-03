// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://en.tankiwiki.com';
const START_PAGE = 'Tanki_Online_Wiki';
const RECENT_CHANGES_FEED_URL = 'https://en.tankiwiki.com/api.php?action=feedrecentchanges&days=7&feedformat=atom&urlversion=1';
const DICTIONARY_URL = 'https://testanki1.github.io/translations.js'; 
const SOURCE_DICT_FILE = 'source_replacements.js'; 
const OUTPUT_DIR = './output';
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');
const REDIRECT_MAP_FILE = path.join(__dirname, 'redirect_map.json');

// 合并页面的字符数阈值（约等于 160k 字符时发车）
const TARGET_BATCH_CHARS = 160000; 

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const aiModelName = "gemini-3.1-flash-lite-preview";
const geminiModel = genAI.getGenerativeModel({ model: aiModelName });

const sanitizePageName = (name) => name.replaceAll(' ', '_');

async function getPagesForFeedMode(lastEditInfo) {
    console.log(`[更新模式] 正在从 ${RECENT_CHANGES_FEED_URL} 获取最近更新...`);
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args:['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.goto(RECENT_CHANGES_FEED_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        let responseText = await page.content();
        
        const $html = cheerio.load(responseText);
        const xmlContainer = $html('#webkit-xml-viewer-source-xml');
        let feedXml = xmlContainer.length ? xmlContainer.html() : responseText;
        feedXml = feedXml.replace(/xmlns="[^"]*"/g, '');

        const $ = cheerio.load(feedXml, { xmlMode: true, decodeEntities: false });
        const entries = $('entry');
        if (entries.length === 0) return new Array();

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

        const pagesToUpdate = new Array();
        for (const[title, newRevisionId] of pagesToConsider.entries()) {
            const blockedPrefixes =['Special:', 'User:', 'MediaWiki:', 'Help:', 'Category:', 'File:', 'Template:'];
            if (blockedPrefixes.some(p => title.startsWith(p))) continue;
            
            const currentRevisionId = lastEditInfo[title] || 0;
            if (newRevisionId > currentRevisionId) pagesToUpdate.push(title);
        }
        return pagesToUpdate;
    } catch (error) {
        console.error('❌ [更新模式] 出错:', error.message);
        return new Array();
    } finally {
        if (browser) await browser.close();
    }
}

async function getOnlineDictionaryString() {
    try { 
        const response = await fetch(DICTIONARY_URL); 
        if (!response.ok) throw new Error(`网络请求失败: ${response.status}`); 
        const scriptContent = await response.text(); 
        const dictObj = new Function(`${scriptContent}; return replacementDict;`)(); 
        
        let dictStr = "";
        for (const [en, zh] of Object.entries(dictObj)) dictStr += `${en} -> ${zh}\n`;
        return dictStr;
    } catch (error) { return ""; } 
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

function containsEnglish(text) { return /[a-zA-Z]/.test(text); }

function formatTypography(htmlStr) {
    if (!htmlStr) return htmlStr;
    let res = htmlStr;
    res = res.replace(/([\u4e00-\u9fa5])(<\/[a-zA-Z0-9]+>)?(?:\s|&nbsp;)*:(?:\s|&nbsp;)*/g, '$1$2：');
    res = res.replace(/([\u4e00-\u9fa5])(<\/[a-zA-Z0-9]+>)?(?:\s|&nbsp;)*,(?:\s|&nbsp;)*/g, '$1$2，');
    res = res.replace(/([\u4e00-\u9fa5])(<\/[a-zA-Z0-9]+>)?(?:\s|&nbsp;)*\.(?:\s|&nbsp;)*/g, '$1$2。');
    res = res.replace(/([\u4e00-\u9fa5])(?:\s|&nbsp;)+([\u4e00-\u9fa5])/g, '$1$2');
    res = res.replace(/([\u4e00-\u9fa5])(?:\s|&nbsp;)+([\u4e00-\u9fa5])/g, '$1$2'); 
    res = res.replace(/([\u4e00-\u9fa5])(?:\s|&nbsp;)+(<[^>]+>)/g, '$1$2');
    res = res.replace(/(<[^>]+>)(?:\s|&nbsp;)+([\u4e00-\u9fa5])/g, '$1$2');
    res = res.replace(/([a-zA-Z0-9])([\u4e00-\u9fa5])/g, '$1 $2');
    res = res.replace(/([\u4e00-\u9fa5])([a-zA-Z0-9])/g, '$1 $2');
    res = res.replace(/([a-zA-Z0-9])(<\/[a-zA-Z0-9]+>)([\u4e00-\u9fa5])/g, '$1$2 $3');
    res = res.replace(/([\u4e00-\u9fa5])(<\/[a-zA-Z0-9]+>)([a-zA-Z0-9])/g, '$1$2 $3');
    res = res.replace(/([a-zA-Z0-9])(<[a-zA-Z0-9]+[^>]*>)([\u4e00-\u9fa5])/g, '$1 $2$3');
    res = res.replace(/([\u4e00-\u9fa5])(<[a-zA-Z0-9]+[^>]*>)([a-zA-Z0-9])/g, '$1 $2$3');
    return res;
}

// 【将所有累积的页面合并数据，发送给 Gemini】
async function translateBatchWithGemini(tasksObj, dictStr) {
    const keys = Object.keys(tasksObj);
    if (keys.length === 0) return {};
    if (!process.env.GEMINI_API_KEY) return tasksObj;

    const results = { ...tasksObj };
    const batches = new Array(); 
    let currentBatch = {}; 
    let currentCharCount = 0;

    for (const key of keys) {
        const itemLength = tasksObj[key].length;
        if (currentCharCount > 0 && (currentCharCount + itemLength) > TARGET_BATCH_CHARS) {
            batches.push(currentBatch); currentBatch = {}; currentCharCount = 0;
        }
        currentBatch[key] = tasksObj[key]; currentCharCount += itemLength;
    }
    if (Object.keys(currentBatch).length > 0) batches.push(currentBatch);

    const dictPrompt = dictStr ? `
4. 【术语表】：严格遵守以下词库：
---
${dictStr}
---
` : "4. 请根据《Tanki Online》的游戏语境进行翻译，保证专业术语准确。";

    for (let i = 0; i < batches.length; i++) {
        const batchObj = batches[i]; const batchKeys = Object.keys(batchObj);
        console.log(`🚀 发送超大合并请求包[${i + 1}/${batches.length}]... (打包了 ${batchKeys.length} 个HTML块)`);

        const prompt = `你是一个专业的《Tanki Online》游戏Wiki翻译引擎。请将以下JSON对象中的值翻译为简体中文。
要求：
1. 键名（Key）绝对不可更改。只翻译键值（Value）。
2. 原样保留所有 HTML 标签！如因语序变动，必须带着完整标签移动！
3. 仅翻译如 title="..." 等显示属性，href、src、id、class 必须原样保留。
${dictPrompt}
5. 中文字符间不可加空格；中英文交界处加半角空格；数值原样保留。
直接输出可被 JSON.parse() 解析的纯 JSON 格式！

待翻译：
${JSON.stringify(batchObj, null, 2)}`;

        let batchResult = null;
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                // 模型调用
                const response = await geminiModel.generateContent({ 
                    contents: new Array({ role: "user", parts: new Array({ text: prompt }) }), 
                    generationConfig: { temperature: 0.1 } 
                });
                let text = response.response.text();
                text = text.replace(/^```(json)?\s*/i, '').replace(/\s*```$/i, '').trim();
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (typeof parsed === 'object' && !Array.isArray(parsed)) { batchResult = parsed; break; }
                }
            } catch (err) {
                console.warn(`⚠️[包尝试 ${attempt}/5] 失败: ${err.message.substring(0, 100)}`);
                if (attempt < 5) await new Promise(r => setTimeout(r, (err.message.includes('429') ? 64000 : 3000)));
            }
        }

        if (batchResult) {
            batchKeys.forEach(k => { if (batchResult[k]) results[k] = batchResult[k]; });
            console.log(`✅ 请求包处理成功！`);
        }
        if (i + 1 < batches.length) await new Promise(r => setTimeout(r, 5000)); 
    }
    return results;
}

function getPageNameFromWikiLink(href) { 
    if (!href) return null; let url; try { url = new URL(href, BASE_URL); } catch (e) { return null; } 
    if (url.hostname !== new URL(BASE_URL).hostname) return null; 
    let pathname = decodeURIComponent(url.pathname); if (pathname.startsWith('/w/index.php')) return null; 
    let pageName = pathname.substring(1); 
    const blockedPrefixes =['Special', 'File', 'User', 'MediaWiki', 'Template', 'Help', 'Category']; 
    if (!pageName || new RegExp(`^(${blockedPrefixes.join('|')}):`, 'i').test(pageName) || pageName.includes('#') || /\.(css|js|png|jpg|jpeg|gif|svg|ico|php)$/i.test(pageName)) return null; 
    return sanitizePageName(pageName); 
}

function findInternalLinks($) { 
    const links = new Set(); $('#mw-content-text a[href]').each((i, el) => { const pn = getPageNameFromWikiLink($(el).attr('href')); if (pn) links.add(pn); }); 
    return Array.from(links); 
}

function findImageReplacement(url, replacementMap) {
    if (!url) return url; if (replacementMap.has(url)) return replacementMap.get(url);
    const match = url.match(/(.*\/images\/\w{2})\/thumb(\/.*?\.\w+)\/\d+px-.*$/i);
    if (match && match[1] && match[2] && replacementMap.has(match[1] + match[2])) return replacementMap.get(match[1] + match[2]);
    return url;
}

// 【阶段 1：只抓取页面，拆分数据入池，不马上翻译】
async function extractPageData(pageNameToProcess, sourceReplacementMap, lastEditInfoState, force = false) {
    const sourceUrl = `${BASE_URL}/${pageNameToProcess}`;
    console.log(`[${pageNameToProcess}] 正在抓取页面结构...`);
    const browser = await puppeteer.launch({ headless: true, args:['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    let htmlContent;

    try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForSelector('#mw-content-text', { timeout: 0 });
        htmlContent = await page.content();
    } catch (error) {
        console.error(`❌[${pageNameToProcess}] 抓取失败: ${error.message}`);
        await browser.close();
        return null;
    } finally {
        await browser.close();
    }
    
    const $ = cheerio.load(htmlContent);
    let rlconf = null;
    const rlconfMatch = htmlContent.match(/RLCONF\s*=\s*(\{[\s\S]*?\});/);
    if (rlconfMatch && rlconfMatch[1]) { try { rlconf = JSON.parse(rlconfMatch[1]); } catch (e) { rlconf = null; } }

    if (!rlconf || rlconf.wgArticleId === 0) return { status: 'cached', links: new Array() };
    const currentEditInfo = rlconf.wgCurRevisionId || rlconf.wgRevisionId || null;
    if (!force && currentEditInfo && lastEditInfoState[pageNameToProcess] === currentEditInfo) {
        return { status: 'cached', links: findInternalLinks($) };
    }

    const headElements = new Array();
    $('head').children('link, style, script, meta, title').each(function() {
        const $el = $(this);
        if ($el.is('link') && $el.attr('href')?.startsWith('/')) $el.attr('href', BASE_URL + $el.attr('href'));
        if ($el.is('script') && $el.attr('src')?.startsWith('/')) $el.attr('src', BASE_URL + $el.attr('src'));
        if ($el.is('meta') && $el.attr('content')) $el.attr('content', findImageReplacement($el.attr('content'), sourceReplacementMap));
        headElements.push($.html(this));
    });

    const bodyEndScripts = new Array(); 
    $('body > script').each(function() { const $el = $(this); if ($el.attr('src')?.startsWith('/')) $el.attr('src', BASE_URL + $el.attr('src')); bodyEndScripts.push($.html(this)); });
    
    bodyEndScripts.push(`<script>function replaceColorsInDom() { const replacements =[{ from: /#?46DF11|rgb\\(70,\\s*223,\\s*17\\)/gi, to: '#76FF33' }, { from: /#?00D7FF/gi, to: '#00D4FF' }, { from: /#?(F86667|F33|FF3333)\\b/gi, to: '#FF6666' }, { from: /#?(FC0|FFCC00)\\b/gi, to: '#FFEE00' }, { from: /#?8C60EB/gi, to: '#D580FF' }]; function applyReplacements(text) { if (!text) return text; let newText = text; for (const rule of replacements) newText = newText.replace(rule.from, rule.to); return newText; } document.querySelectorAll('[style]').forEach(el => { const orig = el.getAttribute('style'); const ns = applyReplacements(orig); if (ns !== orig) el.setAttribute('style', ns); }); document.querySelectorAll('style').forEach(tag => { const orig = tag.innerHTML; const ns = applyReplacements(orig); if (ns !== orig) tag.innerHTML = ns; }); } document.addEventListener('DOMContentLoaded', replaceColorsInDom);<\/script>`);
    bodyEndScripts.push(`<script>document.addEventListener('DOMContentLoaded', function() { document.querySelectorAll('.ShowYouTubePopup').forEach(popup => { if (popup.dataset.biliHandled) return; popup.addEventListener('click', (e) => { e.stopImmediatePropagation(); if (typeof tingle === 'undefined') return; let modal = new tingle.modal({ closeMethods:['button', 'escape', 'overlay'] }); modal.setContent(\`<div class="report-head"><div class="report-title">观看视频</div><div class="report-close"></div></div><div style="margin: 15px 10px 10px 10px;"><iframe class="yt-video" width="640px" height="360px" src="https://player.bilibili.com/player.html?bvid=\${popup.dataset.id}" frameborder="0" allowfullscreen="allowfullscreen"></iframe></div>\`); modal.open(); modal.getContent().querySelector('.report-close').addEventListener('click', () => modal.close()); }, true); popup.dataset.biliHandled = 'true'; }); });<\/script>`);

    const $contentContainer = $('<div id="wiki-content-wrapper"></div>'); 
    $('#firstHeading').clone().appendTo($contentContainer); 
    $('#mw-content-text .mw-parser-output').children().each(function() { $contentContainer.append($(this).clone()); });
    
    const $factBoxContent = $contentContainer.find('.random-text-box > div:last-child'); 
    if ($factBoxContent.length > 0) { 
        $factBoxContent.html('<p id="dynamic-fact-placeholder" style="margin:0;">正在加载有趣的事实...</p>'); 
        bodyEndScripts.push(`<script>document.addEventListener('DOMContentLoaded', function() { fetch('./facts.json').then(r=>r.json()).then(f=>{ document.getElementById('dynamic-fact-placeholder').innerHTML = f[Math.floor(Math.random() * f.length)].cn; }).catch(()=>{}); });<\/script>`); 
    }

    $contentContainer.find('a').each(function() { 
        const $el = $(this); const href = $el.attr('href'); const internalName = getPageNameFromWikiLink(href); 
        if (internalName) $el.attr('href', `./${internalName}`); 
        else if (href && !href.startsWith('#')) try { $el.attr('href', new URL(href, sourceUrl).href); } catch (e) {} 
    });
    
    $contentContainer.find('img, iframe').each(function() {
        const $el = $(this); let src = $el.attr('src');
        if (src) try { $el.attr('src', findImageReplacement(new URL(src, sourceUrl).href, sourceReplacementMap)); } catch (e) {}
    });
    $contentContainer.find('.ShowYouTubePopup[data-id]').each(function() {
        const $el = $(this); const yid = $el.attr('data-id'); if (!yid) return;
        if (sourceReplacementMap.has(yid)) $el.attr('data-id', sourceReplacementMap.get(yid));
    });
    
    let originalTitle = $('title').text() || pageNameToProcess;
    
    // 给每一个块附加上当前页面名称前缀，防止冲突
    const prefix = `PAGE_${pageNameToProcess}___`;
    const tasksObj = {};
    let charCount = 0;

    if (containsEnglish(originalTitle)) {
        tasksObj[`${prefix}title`] = originalTitle;
        charCount += originalTitle.length;
    }
    
    let chunkIndex = 0;
    function extractChunksToTranslate($parent) {
        $parent.children().each((_, el) => {
            const $el = $(el);
            const outerHtml = $.html($el);
            if (!containsEnglish(outerHtml)) return;

            if (outerHtml.length > 8000 && $el.children().length > 0) {
                extractChunksToTranslate($el);
            } else {
                const chunkId = `chunk_${chunkIndex++}`;
                $el.attr('data-translate-id', chunkId);
                tasksObj[`${prefix}${chunkId}`] = outerHtml;
                charCount += outerHtml.length;
            }
        });
    }

    extractChunksToTranslate($contentContainer);
    
    console.log(`[${pageNameToProcess}] 解析入池成功。 (约 ${charCount} 字符)`);

    return { 
        status: 'extracted',
        tasks: tasksObj,
        charCount: charCount,
        links: findInternalLinks($),
        pageData: {
            pageName: pageNameToProcess,
            containerHtml: $contentContainer.html(),
            headElements,
            bodyEndScripts,
            originalTitle,
            currentEditInfo,
            bodyClass: $('body').attr('class') || ''
        }
    };
}

// 【阶段 2：用翻译完的数据将页面重构拼装】
function buildAndSavePage(pageData, translatedResults) {
    const { pageName, containerHtml, headElements, bodyEndScripts, originalTitle, currentEditInfo, bodyClass } = pageData;
    const prefix = `PAGE_${pageName}___`;

    let finalTitle = originalTitle;
    if (translatedResults[`${prefix}title`]) {
        finalTitle = formatTypography(translatedResults[`${prefix}title`]);
    }

    const $ = cheerio.load('<body></body>');
    const $contentContainer = $('<div id="wiki-content-wrapper"></div>');
    $contentContainer.html(containerHtml);

    Object.keys(translatedResults).forEach(key => {
        if (key.startsWith(`${prefix}chunk_`) && translatedResults[key]) {
            const originalChunkId = key.replace(prefix, '');
            const $target = $contentContainer.find(`[data-translate-id="${originalChunkId}"]`);
            if ($target.length) $target.replaceWith(translatedResults[key]);
        }
    });

    $contentContainer.find('[data-translate-id]').removeAttr('data-translate-id');

    let finalHtmlContent = formatTypography($contentContainer.html());
    let homeButtonHtml = pageName !== START_PAGE ? `<a href="./${START_PAGE}" style="display: inline-block; margin: 0 0 25px 0; padding: 12px 24px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.2);">返回主页</a>` : '';
    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    '); 
    
    const finalHtml = `<!DOCTYPE html><html lang="zh-CN" dir="ltr"><head><meta charset="UTF-8"><title>${finalTitle}</title>${headContent}<style>@import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');body{font-family:'Rubik','M PLUS 1p',sans-serif;background-color:#001926 !important;}#mw-main-container{max-width:1200px;margin:20px auto;background-color:#001926;padding:20px;}</style></head><body class="${bodyClass}"><div id="mw-main-container">${homeButtonHtml}<div class="main-content"><div class="mw-body" id="content"><a id="top"></a><div class="mw-body-content"><div id="mw-content-text" class="mw-parser-output" lang="zh-CN" dir="ltr">${finalHtmlContent}</div></div></div></div></div>${bodyEndScripts.join('\n    ')}</body></html>`;
    
    fs.writeFileSync(path.join(OUTPUT_DIR, `${pageName}.html`), finalHtml, 'utf-8');
    console.log(`✅[${pageName}] HTML 重构并保存完成！`);
    return currentEditInfo;
}

// 【主控逻辑】
async function run() {
    console.log(`--- 翻译任务开始 (AI模型: ${aiModelName}) ---`);
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

    const sourceReplacementMap = getPreparedSourceDictionary();
    const dictStr = await getOnlineDictionaryString();
    
    let lastEditInfo = {};
    if (fs.existsSync(EDIT_INFO_FILE)) try { lastEditInfo = JSON.parse(fs.readFileSync(EDIT_INFO_FILE, 'utf-8')); } catch (e) {}

    const runMode = (process.env.RUN_MODE || 'FEED').toUpperCase();
    let pagesToVisit = new Array();

    switch (runMode) {
        case 'FEED': pagesToVisit = await getPagesForFeedMode(lastEditInfo); break;
        case 'CRAWLER': pagesToVisit = [START_PAGE]; break;
        case 'SPECIFIED':
            pagesToVisit = (process.env.PAGES_TO_PROCESS || '').split(',').map(p => sanitizePageName(p.trim())).filter(Boolean);
            break;
    }

    if (pagesToVisit.length === 0) return console.log("没有需要处理的页面，任务提前结束。");
    
    const visitedPages = new Set();
    const isForceMode = runMode === 'FEED' || runMode === 'SPECIFIED';
    let pageIndex = 0;

    // 创建全局池
    let globalTasksPool = {};
    let pendingPagesData = new Array();
    let poolCharCount = 0;

    while (pageIndex < pagesToVisit.length) {
        const currentPageName = pagesToVisit[pageIndex++];
        if (visitedPages.has(currentPageName)) continue;
        visitedPages.add(currentPageName);

        const result = await extractPageData(currentPageName, sourceReplacementMap, lastEditInfo, isForceMode);
        
        if (result) {
            if (runMode === 'CRAWLER' && result.links) {
                for (const link of result.links) {
                    if (!visitedPages.has(link) && !pagesToVisit.includes(link)) pagesToVisit.push(link);
                }
            }

            if (result.status === 'cached') {
                console.log(`💤 [${currentPageName}] 缓存未变跳过。`);
            } else if (result.status === 'extracted') {
                Object.assign(globalTasksPool, result.tasks);
                poolCharCount += result.charCount;
                pendingPagesData.push(result.pageData);
            }
        }

        const isLastPage = pageIndex === pagesToVisit.length;
        // 如果池子满了，或者所有页面都抓完了，发车！
        if (poolCharCount >= TARGET_BATCH_CHARS || isLastPage) {
            if (Object.keys(globalTasksPool).length > 0) {
                console.log(`\n==============================================`);
                console.log(`📦 【触发合并发车】累积字符: ${poolCharCount}，包含页面数: ${pendingPagesData.length}`);
                console.log(`==============================================\n`);

                const translatedResults = await translateBatchWithGemini(globalTasksPool, dictStr);

                for (const pageData of pendingPagesData) {
                    const newEditInfo = buildAndSavePage(pageData, translatedResults);
                    if (newEditInfo) lastEditInfo[pageData.pageName] = newEditInfo;
                }

                // 清空重置池子状态，并及时存档
                globalTasksPool = {};
                pendingPagesData = new Array();
                poolCharCount = 0;

                try {
                    fs.writeFileSync(EDIT_INFO_FILE, JSON.stringify(lastEditInfo, null, 2), 'utf-8');
                } catch (e) {}
            }
        }
    }

    console.log("--- 所有页面处理完毕，任务结束！ ---");
}

run().catch(console.error);
