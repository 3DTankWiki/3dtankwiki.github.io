// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// --- 【配置常量】 ---
const BASE_URL = 'https://en.tankiwiki.com';
const START_PAGE = 'Tanki_Online_Wiki';
const RECENT_CHANGES_FEED_URL = 'https://en.tankiwiki.com/api.php?action=feedrecentchanges&days=7&feedformat=atom&urlversion=1';
const CONCURRENCY_LIMIT = 1; 
const DICTIONARY_URL = 'https://testanki1.github.io/translations.js'; 
const SOURCE_DICT_FILE = 'source_replacements.js'; 
const OUTPUT_DIR = './output';
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');
const REDIRECT_MAP_FILE = path.join(__dirname, 'redirect_map.json');

// 初始化 Gemini 客户端
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

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

        const pagesToUpdate = [];
        for (const[title, newRevisionId] of pagesToConsider.entries()) {
            const blockedPrefixes =['Special:', 'User:', 'MediaWiki:', 'Help:', 'Category:', 'File:', 'Template:'];
            if (blockedPrefixes.some(p => title.startsWith(p))) continue;
            
            const currentRevisionId = lastEditInfo[title] || 0;
            if (newRevisionId > currentRevisionId) pagesToUpdate.push(title);
        }
        return pagesToUpdate;
    } catch (error) {
        console.error('❌ [更新模式] 出错:', error.message);
        return[];
    } finally {
        if (browser) await browser.close();
    }
}

async function getOnlineDictionaryString() {
    console.log(`正在从 URL 获取专有名词翻译词典: ${DICTIONARY_URL}`); 
    try { 
        const response = await fetch(DICTIONARY_URL); 
        if (!response.ok) throw new Error(`网络请求失败: ${response.status}`); 
        const scriptContent = await response.text(); 
        const dictObj = new Function(`${scriptContent}; return replacementDict;`)(); 
        
        let dictStr = "";
        for (const [en, zh] of Object.entries(dictObj)) {
            dictStr += `${en} -> ${zh}\n`;
        }
        console.log(`✅ 成功加载翻译词典，将作为指令发送给 AI。`);
        return dictStr;
    } catch (error) { 
        console.warn(`⚠️ 获取在线词典失败，将不使用专有词库提示AI: ${error.message}`);
        return ""; 
    } 
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

// === 【最终形态】排版格式化工具（处理标点与实体空格） ===
function formatTypography(htmlStr) {
    if (!htmlStr) return htmlStr;
    let res = htmlStr;

    // 0. 中文语境下的标点符号转换 (处理冒号、逗号、句号及其后多余的空格/&nbsp;)
    // 匹配规则：汉字 +[可选的闭合标签如</em>] + [可选空格或&nbsp;] + 半角标点 + [可选空格或&nbsp;]
    res = res.replace(/([\u4e00-\u9fa5])(<\/[a-zA-Z0-9]+>)?(?:\s|&nbsp;)*:(?:\s|&nbsp;)*/g, '$1$2：');
    res = res.replace(/([\u4e00-\u9fa5])(<\/[a-zA-Z0-9]+>)?(?:\s|&nbsp;)*,(?:\s|&nbsp;)*/g, '$1$2，');
    res = res.replace(/([\u4e00-\u9fa5])(<\/[a-zA-Z0-9]+>)?(?:\s|&nbsp;)*\.(?:\s|&nbsp;)*/g, '$1$2。');

    // 1. 去除纯汉字与纯汉字之间的所有空格和 &nbsp; (执行两次防多空格遗漏)
    res = res.replace(/([\u4e00-\u9fa5])(?:\s|&nbsp;)+([\u4e00-\u9fa5])/g, '$1$2');
    res = res.replace(/([\u4e00-\u9fa5])(?:\s|&nbsp;)+([\u4e00-\u9fa5])/g, '$1$2'); 
    
    // 2. 穿透 HTML 标签的无用空格清除 (兼容包含 &nbsp; 的情况)
    // 缝合前缀：汉字 + 多余空格/&nbsp; + 标签
    res = res.replace(/([\u4e00-\u9fa5])(?:\s|&nbsp;)+(<[^>]+>)/g, '$1$2');
    // 缝合后缀：标签 + 多余空格/&nbsp; + 汉字
    res = res.replace(/(<[^>]+>)(?:\s|&nbsp;)+([\u4e00-\u9fa5])/g, '$1$2');

    // 3. 纯文本内：英文字母/数字 与 汉字 之间强制增加空格
    res = res.replace(/([a-zA-Z0-9])([\u4e00-\u9fa5])/g, '$1 $2');
    res = res.replace(/([\u4e00-\u9fa5])([a-zA-Z0-9])/g, '$1 $2');

    // 4. 跨越 HTML 标签时的中英文缝隙弥补
    res = res.replace(/([a-zA-Z0-9])(<\/[a-zA-Z0-9]+>)([\u4e00-\u9fa5])/g, '$1$2 $3');
    res = res.replace(/([\u4e00-\u9fa5])(<\/[a-zA-Z0-9]+>)([a-zA-Z0-9])/g, '$1$2 $3');
    res = res.replace(/([a-zA-Z0-9])(<[a-zA-Z0-9]+[^>]*>)([\u4e00-\u9fa5])/g, '$1 $2$3');
    res = res.replace(/([\u4e00-\u9fa5])(<[a-zA-Z0-9]+[^>]*>)([a-zA-Z0-9])/g, '$1 $2$3');

    return res;
}

// 【将完整 HTML 和 翻译字典 一起投喂给 Gemini】
async function translateBatchWithGemini(tasksObj, dictStr) {
    const keys = Object.keys(tasksObj);
    if (keys.length === 0) return {};
    if (!process.env.GEMINI_API_KEY) {
        console.warn("⚠️ 未配置 GEMINI_API_KEY，跳过机翻。");
        return tasksObj;
    }

    const results = { ...tasksObj };
    const batchSize = 10; 
    
    const dictPrompt = dictStr ? `
3. 【术语表要求】：请严格遵守以下提供的《翻译专有名词词库》。只要原文出现了词库中的英文，必须统一翻译为对应的中文：
--- 词库开始 ---
${dictStr}
--- 词库结束 ---
` : "3. 请根据《Tanki Online》（3D坦克）的游戏语境进行翻译，保证专业术语准确。";

    for (let i = 0; i < keys.length; i += batchSize) {
        const batchKeys = keys.slice(i, i + batchSize);
        const batchObj = {};
        batchKeys.forEach(k => batchObj[k] = tasksObj[k]);

        // 【修改】彻底完善针对特殊字符和标点的提示词
        const prompt = `你是一个专业的《Tanki Online》（3D坦克）游戏维基本地化翻译引擎。
请将以下 JSON 对象中的值（包含完整 HTML 标签的代码块）翻译为简体中文。

【极端重要的要求】：
1. JSON的键名（Key）绝对不可更改。只翻译键值（Value）。
2. 键值是包含完整 HTML 结构的字符串，你【必须原样保留】所有的 HTML 标签、类名、ID、内联样式和内部属性！绝对不能破坏 DOM 结构或遗漏任何标签！
${dictPrompt}
4. 【盘古之白排版与标点规范 - 极其重要】：
   - 中文语境下，请将原文的英文标点（如半角冒号":"、逗号","、句号"."等）转换为对应的全角中文标点（"："、"，"、"。"）。
   - 中文字符与中文字符之间【绝对不要加空格或 &nbsp; 实体】，即使它们被 HTML 标签隔开！比如输出必须是 "为了用<a href="...">红宝石</a>购买"，决不能是 "为了用 <a>红宝石</a> 购买" 或是 "温度</a>&nbsp;和"！
   - 【英文/数字】与【中文汉字】的交界处，请加上一个半角空格！
5. 除了词库中的术语，其余部分请结合上下文翻译得专业流畅。
6. 绝对不要使用 Markdown 代码块包裹输出！直接输出合法的、可被 JSON.parse() 解析的纯 JSON 格式！

待翻译 HTML 块的 JSON：
${JSON.stringify(batchObj, null, 2)}`;

        let batchResult = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await geminiModel.generateContent({
                    contents:[{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.1 } 
                });
                let text = response.response.text();
                
                text = text.replace(/^```(json)?\s*/i, '').replace(/\s*```$/i, '').trim();
                
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
                        batchResult = parsed;
                        break;
                    }
                }
            } catch (err) {
                console.warn(`[Gemini 翻译尝试 ${attempt}/3] 失败: ${err.message}`);
            }
            if (!batchResult && attempt < 3) await new Promise(r => setTimeout(r, 2000));
        }

        if (batchResult) {
            batchKeys.forEach(k => { if (batchResult[k]) results[k] = batchResult[k]; });
        } else {
            console.warn(`⚠️ 该批次彻底失败，回退为原始 HTML。`);
        }

        if (i + batchSize < keys.length) await new Promise(r => setTimeout(r, 4000)); 
    }
    
    return results;
}

function getPageNameFromWikiLink(href) { 
    if (!href) return null; let url; try { url = new URL(href, BASE_URL); } catch (e) { return null; } 
    if (url.hostname !== new URL(BASE_URL).hostname) return null; 
    let pathname = decodeURIComponent(url.pathname); if (pathname.startsWith('/w/index.php')) return null; 
    let pageName = pathname.substring(1); 
    const blockedPrefixes =['Special', 'File', 'User', 'MediaWiki', 'Template', 'Help', 'Category']; 
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

async function processPage(pageNameToProcess, sourceReplacementMap, dictStr, lastEditInfoState, force = false) {
    const sourceUrl = `${BASE_URL}/${pageNameToProcess}`;
    console.log(`[${pageNameToProcess}] 开始抓取页面...`);
    const browser = await puppeteer.launch({ headless: true, args:['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    let htmlContent;

    try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForSelector('#mw-content-text', { timeout: 0 });
        htmlContent = await page.content();
    } catch (error) {
        console.error(`抓取失败: ${error.message}`);
        await browser.close();
        return null;
    } finally {
        await browser.close();
    }
    
    const $ = cheerio.load(htmlContent);
    let rlconf = null;
    const rlconfMatch = htmlContent.match(/RLCONF\s*=\s*(\{[\s\S]*?\});/);
    if (rlconfMatch && rlconfMatch[1]) { try { rlconf = JSON.parse(rlconfMatch[1]); } catch (e) { rlconf = null; } }

    if (!rlconf || rlconf.wgArticleId === 0) return { links:[] };
    const currentEditInfo = rlconf.wgCurRevisionId || rlconf.wgRevisionId || null;
    if (!force && currentEditInfo && lastEditInfoState[pageNameToProcess] === currentEditInfo) {
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
    
    let translatedTitle = $('title').text() || pageNameToProcess;

    const tasksObj = {};
    if (containsEnglish(translatedTitle)) tasksObj['title_0'] = translatedTitle;
    
    const $topLevelElements = $contentContainer.children();
    $topLevelElements.each((i, el) => {
        const outerHtml = $.html(el);
        if (containsEnglish(outerHtml)) {
            tasksObj[`chunk_${i}`] = outerHtml;
        }
    });

    console.log(`[${pageNameToProcess}] 发送给 AI ${Object.keys(tasksObj).length} 个带标签的完整 HTML 块...`);
    const translatedResults = await translateBatchWithGemini(tasksObj, dictStr);

    if (translatedResults['title_0']) {
        translatedTitle = formatTypography(translatedResults['title_0']);
    }
    
    $topLevelElements.each((i, el) => {
        if (translatedResults[`chunk_${i}`]) {
            $(el).replaceWith(translatedResults[`chunk_${i}`]);
        }
    });
    
    let finalHtmlContent = $contentContainer.html();
    finalHtmlContent = formatTypography(finalHtmlContent);

    let homeButtonHtml = pageNameToProcess !== START_PAGE ? `<a href="./${START_PAGE}" style="display: inline-block; margin: 0 0 25px 0; padding: 12px 24px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.2);">返回主页</a>` : '';
    
    const colorReplacementScript = `<script>function replaceColorsInDom() { const replacements =[{ from: /#?46DF11|rgb\\(70,\\s*223,\\s*17\\)/gi, to: '#76FF33' }, { from: /#?00D7FF/gi, to: '#00D4FF' }, { from: /#?(F86667|F33|FF3333)\\b/gi, to: '#FF6666' }, { from: /#?(FC0|FFCC00)\\b/gi, to: '#FFEE00' }, { from: /#?8C60EB/gi, to: '#D580FF' }]; function applyReplacements(text) { if (!text) return text; let newText = text; for (const rule of replacements) newText = newText.replace(rule.from, rule.to); return newText; } document.querySelectorAll('[style]').forEach(el => { const orig = el.getAttribute('style'); const ns = applyReplacements(orig); if (ns !== orig) el.setAttribute('style', ns); }); document.querySelectorAll('style').forEach(tag => { const orig = tag.innerHTML; const ns = applyReplacements(orig); if (ns !== orig) tag.innerHTML = ns; }); } document.addEventListener('DOMContentLoaded', replaceColorsInDom);<\/script>`;
    bodyEndScripts.push(colorReplacementScript);

    const bilibiliPopupScript = `<script>document.addEventListener('DOMContentLoaded', function() { document.querySelectorAll('.ShowYouTubePopup').forEach(popup => { if (popup.dataset.biliHandled) return; popup.addEventListener('click', (e) => { e.stopImmediatePropagation(); if (typeof tingle === 'undefined') return; let modal = new tingle.modal({ closeMethods:['button', 'escape', 'overlay'] }); modal.setContent(\`<div class="report-head"><div class="report-title">观看视频</div><div class="report-close"></div></div><div style="margin: 15px 10px 10px 10px;"><iframe class="yt-video" width="640px" height="360px" src="https://player.bilibili.com/player.html?bvid=\${popup.dataset.id}" frameborder="0" allowfullscreen="allowfullscreen"></iframe></div>\`); modal.open(); modal.getContent().querySelector('.report-close').addEventListener('click', () => modal.close()); }, true); popup.dataset.biliHandled = 'true'; }); });<\/script>`;
    bodyEndScripts.push(bilibiliPopupScript);
    
    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    '); 
    const finalHtml = `<!DOCTYPE html><html lang="zh-CN" dir="ltr"><head><meta charset="UTF-8"><title>${translatedTitle}</title>${headContent}<style>@import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');body{font-family:'Rubik','M PLUS 1p',sans-serif;background-color:#001926 !important;}#mw-main-container{max-width:1200px;margin:20px auto;background-color:#001926;padding:20px;}</style></head><body class="${$('body').attr('class') || ''}"><div id="mw-main-container">${homeButtonHtml}<div class="main-content"><div class="mw-body" id="content"><a id="top"></a><div class="mw-body-content"><div id="mw-content-text" class="mw-parser-output" lang="zh-CN" dir="ltr">${finalHtmlContent}</div></div></div></div></div>${bodyEndScripts.join('\n    ')}</body></html>`;
    
    fs.writeFileSync(path.join(OUTPUT_DIR, `${pageNameToProcess}.html`), finalHtml, 'utf-8');
    console.log(`✅ [${pageNameToProcess}] 翻译完成！`);
    return { translationResult: { pageName: pageNameToProcess, newEditInfo: currentEditInfo }, links: findInternalLinks($) };
}

async function run() {
    console.log("--- 翻译任务开始 ---");
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

    const sourceReplacementMap = getPreparedSourceDictionary();
    const dictStr = await getOnlineDictionaryString();
    
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

            const task = processPage(currentPageName, sourceReplacementMap, dictStr, lastEditInfo, isForceMode)
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
