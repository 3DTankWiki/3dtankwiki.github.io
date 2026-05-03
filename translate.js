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
const DICTIONARY_URL = 'https://testanki1.github.io/translations.js'; 
const SOURCE_DICT_FILE = 'source_replacements.js'; 
const OUTPUT_DIR = './output';
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');
const REDIRECT_MAP_FILE = path.join(__dirname, 'redirect_map.json');

// 合并页面的字符数阈值
const TARGET_BATCH_CHARS = 160000; 

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
    console.log(`正在从 URL 获取专有名词翻译词典...`); 
    try { 
        const response = await fetch(DICTIONARY_URL); 
        if (!response.ok) throw new Error(`网络请求失败: ${response.status}`); 
        const scriptContent = await response.text(); 
        const dictObj = new Function(`${scriptContent}; return replacementDict;`)(); 
        let dictStr = "";
        for (const [en, zh] of Object.entries(dictObj)) dictStr += `${en} -> ${zh}\n`;
        console.log(`✅ 成功加载翻译词典。`);
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
    return res;
}

async function translateBatchWithGemini(tasksObj, dictStr) {
    const keys = Object.keys(tasksObj);
    if (keys.length === 0) return {};
    if (!process.env.GEMINI_API_KEY) return tasksObj;

    const results = { ...tasksObj };
    
    const batches =[];
    let currentBatch = {};
    let currentCharCount = 0;

    for (const key of keys) {
        const itemLength = tasksObj[key].length;
        if (currentCharCount > 0 && (currentCharCount + itemLength) > TARGET_BATCH_CHARS) {
            batches.push(currentBatch);
            currentBatch = {};
            currentCharCount = 0;
        }
        currentBatch[key] = tasksObj[key];
        currentCharCount += itemLength;
    }
    if (Object.keys(currentBatch).length > 0) batches.push(currentBatch);

    const dictPrompt = dictStr ? `
4. 【术语表要求】：严格遵守以下词库：
---
${dictStr}
---
` : "4. 请根据《Tanki Online》的游戏语境翻译。";

    for (let i = 0; i < batches.length; i++) {
        const batchObj = batches[i];
        const batchKeys = Object.keys(batchObj);
        console.log(`🚀 正在发送请求包 [${i + 1}/${batches.length}]... (包含 ${batchKeys.length} 个HTML块)`);

        const prompt = `你是一个专业的《Tanki Online》游戏Wiki翻译引擎。请将以下JSON对象中的值翻译为简体中文。
【要求】：
1. 键名（Key）不可更改，只翻译值（Value）。
2. 原样保留所有HTML标签！如因语序变动，必须带着完整标签移动！
3. 仅翻译如 title="..." 等可见属性，href/src/id/class等功能属性原样保留。
${dictPrompt}
5. 排版：中文字符间无空格；中英文交界处加一个半角空格；数值原样保留。
直接输出可被JSON.parse()解析的纯JSON格式！

待翻译:
${JSON.stringify(batchObj, null, 2)}`;

        let batchResult = null;
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                const response = await geminiModel.generateContent({ contents:[{ role: "user", parts:[{ text: prompt }] }], generationConfig: { temperature: 0.1 } });
                let text = response.response.text();
                text = text.replace(/^```(json)?\s*/i, '').replace(/\s*```$/i, '').trim();
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (typeof parsed === 'object' && !Array.isArray(parsed)) { batchResult = parsed; break; }
                }
            } catch (err) {
                console.warn(`⚠️[请求包尝试 ${attempt}/5] 失败: ${err.message.substring(0, 150)}`);
                if (attempt < 5) await new Promise(r => setTimeout(r, 3000));
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

async function processPage(pageNameToProcess, sourceReplacementMap, dictStr, lastEditInfoState, force = false) {
    const sourceUrl = `${BASE_URL}/${pageNameToProcess}`;
    console.log(`[${pageNameToProcess}] 正在抓取页面...`);
    const browser = await puppeteer.launch({ headless: true, args:['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    let htmlContent;

    try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForSelector('#mw-content-text', { timeout: 0 });
        htmlContent = await page.content();
    } catch (error) {
        console.error(`❌ [${pageNameToProcess}] 抓取失败: ${error.message}`);
        await browser.close();
        return { status: 'error' };
    } finally {
        await browser.close();
    }
    
    const $ = cheerio.load(htmlContent);
    let rlconf = null;
    const rlconfMatch = htmlContent.match(/RLCONF\s*=\s*(\{[\s\S]*?\});/);
    if (rlconfMatch && rlconfMatch[1]) { try { rlconf = JSON.parse(rlconfMatch[1]); } catch (e) { rlconf = null; } }

    if (!rlconf || rlconf.wgArticleId === 0) return { status: 'cached', links:[] };
    const currentEditInfo = rlconf.wgCurRevisionId || rlconf.wgRevisionId || null;
    if (!force && currentEditInfo && lastEditInfoState[pageNameToProcess] === currentEditInfo) {
        return { status: 'cached', links: findInternalLinks($) };
    }

    const headElements =[];
    $('head').children('link, style, script, meta, title').each(function() {
        const $el = $(this);
        if ($el.is('link') && $el.attr('href')?.startsWith('/')) $el.attr('href', BASE_URL + $el.attr('href'));
        if ($el.is('script') && $el.attr('src')?.startsWith('/')) $el.attr('src', BASE_URL + $el.attr('src'));
        headElements.push($.html(this));
    });

    const bodyEndScripts =[]; 
    $('body > script').each(function() { const $el = $(this); if ($el.attr('src')?.startsWith('/')) $el.attr('src', BASE_URL + $el.attr('src')); bodyEndScripts.push($.html(this)); });
    
    const $contentContainer = $('<div id="wiki-content-wrapper"></div>'); 
    $('#firstHeading').clone().appendTo($contentContainer); 
    $('#mw-content-text .mw-parser-output').children().each(function() { $contentContainer.append($(this).clone()); });
    
    $contentContainer.find('a').each(function() { 
        const $el = $(this); const href = $el.attr('href'); const internalName = getPageNameFromWikiLink(href); 
        if (internalName) $el.attr('href', `./${internalName}`); 
        else if (href && !href.startsWith('#')) try { $el.attr('href', new URL(href, sourceUrl).href); } catch (e) {} 
    });
    $contentContainer.find('img').each(function() {
        const $el = $(this); let src = $el.attr('src');
        if (src) try { $el.attr('src', new URL(src, sourceUrl).href); } catch (e) {}
    });
    
    let originalTitle = $('title').text() || pageNameToProcess;
    const tasksObj = {};
    let totalCharCount = 0;

    if (containsEnglish(originalTitle)) {
        tasksObj[`${pageNameToProcess}___title_0`] = originalTitle;
        totalCharCount += originalTitle.length;
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
                tasksObj[`${pageNameToProcess}___${chunkId}`] = outerHtml;
                totalCharCount += outerHtml.length;
            }
        });
    }
    extractChunksToTranslate($contentContainer);

    if (totalCharCount >= TARGET_BATCH_CHARS) {
        console.log(`[${pageNameToProcess}] 页面过大 (${totalCharCount} 字符)，将立即单独处理...`);
        
        const translatedResults = await translateBatchWithGemini(tasksObj, dictStr);

        let translatedTitle = originalTitle;
        if (translatedResults[`${pageNameToProcess}___title_0`]) {
            translatedTitle = formatTypography(translatedResults[`${pageNameToProcess}___title_0`]);
        }
    
        Object.keys(translatedResults).forEach(key => {
            const keyPrefix = `${pageNameToProcess}___`;
            if (key.startsWith(keyPrefix) && translatedResults[key]) {
                const chunkId = key.substring(keyPrefix.length);
                if (chunkId.startsWith('chunk_')) {
                    const $target = $contentContainer.find(`[data-translate-id="${chunkId}"]`);
                    if ($target.length) $target.replaceWith(translatedResults[key]);
                }
            }
        });
        $contentContainer.find('[data-translate-id]').removeAttr('data-translate-id');

        let finalHtmlContent = formatTypography($contentContainer.html());
        let homeButtonHtml = pageNameToProcess !== START_PAGE ? `<a href="./${START_PAGE}" style="display: inline-block; margin: 10px 0; padding: 10px 15px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 5px;">返回主页</a>` : '';
        const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    '); 
        const finalHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${translatedTitle}</title>${headContent}</head><body class="${$('body').attr('class') || ''}">${homeButtonHtml}<div id="mw-content-text">${finalHtmlContent}</div>${bodyEndScripts.join('\n    ')}</body></html>`;
    
        fs.writeFileSync(path.join(OUTPUT_DIR, `${pageNameToProcess}.html`), finalHtml, 'utf-8');
        console.log(`✅ [${pageNameToProcess}] 单独处理完成！`);
        return { status: 'processed_immediately', newEditInfo: currentEditInfo, links: findInternalLinks($) };

    } else {
        console.log(`[${pageNameToProcess}] 页面大小适中 (${totalCharCount} 字符)，添加入池...`);
        return { 
            status: 'pooled',
            tasks: tasksObj,
            charCount: totalCharCount,
            links: findInternalLinks($),
            pageData: {
                pageName: pageNameToProcess,
                containerHtml: $contentContainer.html(),
                headElements, bodyEndScripts, originalTitle, currentEditInfo,
                bodyClass: $('body').attr('class') || ''
            }
        };
    }
}

async function run() {
    console.log("--- 翻译任务开始 ---");
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

    const sourceReplacementMap = getPreparedSourceDictionary();
    const dictStr = await getOnlineDictionaryString();
    
    let lastEditInfo = {};
    if (fs.existsSync(EDIT_INFO_FILE)) try { lastEditInfo = JSON.parse(fs.readFileSync(EDIT_INFO_FILE, 'utf-8')); } catch (e) {}

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
    const isForceMode = runMode === 'FEED' || runMode === 'SPECIFIED';
    let pageIndex = 0;

    let globalTasksPool = {};
    let pendingPagesData =[];
    let poolCharCount = 0;

    while (pageIndex < pagesToVisit.length) {
        const currentPageName = pagesToVisit[pageIndex++];
        if (visitedPages.has(currentPageName)) continue;
        visitedPages.add(currentPageName);

        const result = await processPage(currentPageName, sourceReplacementMap, dictStr, lastEditInfo, isForceMode);
        
        if (result) {
            if (runMode === 'CRAWLER' && result.links) {
                for (const link of result.links) {
                    if (!visitedPages.has(link) && !pagesToVisit.includes(link)) pagesToVisit.push(link);
                }
            }

            switch(result.status) {
                case 'cached':
                    console.log(`💤 [${currentPageName}] 内容无更新，跳过。`);
                    break;
                case 'processed_immediately':
                    if (result.newEditInfo) lastEditInfo[currentPageName] = result.newEditInfo;
                    break;
                case 'pooled':
                    Object.assign(globalTasksPool, result.tasks);
                    poolCharCount += result.charCount;
                    pendingPagesData.push(result.pageData);
                    break;
            }
        }

        const isLastPage = pageIndex === pagesToVisit.length;
        if (poolCharCount >= TARGET_BATCH_CHARS || (isLastPage && poolCharCount > 0)) {
            console.log(`\n==============================================`);
            console.log(`📦 【触发合并发车】累积字符数: ${poolCharCount}，包含 ${pendingPagesData.length} 个小页面！`);
            console.log(`==============================================\n`);

            const translatedResults = await translateBatchWithGemini(globalTasksPool, dictStr);

            for (const pageData of pendingPagesData) {
                const { pageName, containerHtml, headElements, bodyEndScripts, originalTitle, currentEditInfo, bodyClass } = pageData;
                let finalTitle = originalTitle;
                if (translatedResults[`${pageName}___title_0`]) {
                    finalTitle = formatTypography(translatedResults[`${pageName}___title_0`]);
                }
                
                const $ = cheerio.load(containerHtml, null, false);
                const $contentContainer = $('body').children().first();

                Object.keys(translatedResults).forEach(key => {
                    const keyPrefix = `${pageName}___`;
                    if (key.startsWith(keyPrefix) && translatedResults[key]) {
                        const chunkId = key.substring(keyPrefix.length);
                        if(chunkId.startsWith('chunk_')) {
                            const $target = $contentContainer.find(`[data-translate-id="${chunkId}"]`);
                            if ($target.length) $target.replaceWith(translatedResults[key]);
                        }
                    }
                });
                $contentContainer.find('[data-translate-id]').removeAttr('data-translate-id');

                let finalHtmlContent = formatTypography($contentContainer.html());
                let homeButtonHtml = pageName !== START_PAGE ? `<a href="./${START_PAGE}" style="display: inline-block; margin: 10px 0; padding: 10px 15px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 5px;">返回主页</a>` : '';
                const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    ');
                const finalHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${finalTitle}</title>${headContent}</head><body class="${bodyClass}">${homeButtonHtml}<div id="mw-content-text">${finalHtmlContent}</div>${bodyEndScripts.join('\n    ')}</body></html>`;
                fs.writeFileSync(path.join(OUTPUT_DIR, `${pageName}.html`), finalHtml, 'utf-8');
                console.log(`✅ [${pageName}] (来自合并批次) 处理完成！`);
                if (currentEditInfo) lastEditInfo[pageName] = currentEditInfo;
            }

            globalTasksPool = {};
            pendingPagesData =[];
            poolCharCount = 0;
        }
    }

    try {
        fs.writeFileSync(EDIT_INFO_FILE, JSON.stringify(lastEditInfo, null, 2), 'utf-8');
    } catch (e) {}
    console.log("--- 所有页面处理完毕，任务结束！ ---");
}

run().catch(console.error);
