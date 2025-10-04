// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { translate: bingTranslate } = require('bing-translate-api');
const pluralize = require('pluralize');
const fs = require('fs');
const path = require('path');

// --- 【配置常量】 ---
const BASE_URL = 'https://en.tankiwiki.com';
const START_PAGE = 'Tanki_Online_Wiki'; // 起始页已是下划线格式
const RECENT_CHANGES_FEED_URL = 'https://en.tankiwiki.com/api.php?action=feedrecentchanges&days=7&feedformat=atom&urlversion=1';
const CONCURRENCY_LIMIT = 4;
const DICTIONARY_URL = 'https://testanki1.github.io/translations.js';
const SOURCE_DICT_FILE = 'source_replacements.js'; // 【修改】文件名已更新
const OUTPUT_DIR = './output';
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');
const REDIRECT_MAP_FILE = path.join(__dirname, 'redirect_map.json');
const BING_TRANSLATE_RETRIES = 5;
const BING_RETRY_DELAY = 1500;

// 【核心修改】全局辅助函数，用于统一页面名称格式
const sanitizePageName = (name) => name.replaceAll(' ', '_');

/**
 * [最终修正版 v8] 解析 Atom Feed, 统一将页面名称中的空格转为下划线作为内部Key。
 * @param {object} lastEditInfo - 本地存储的版本信息 (key已是下划线格式)
 * @returns {Promise<string[]>} - 需要更新的页面名称列表 (已是下划线格式)
 */
async function getPagesForFeedMode(lastEditInfo) {
    console.log(`[更新模式] 正在从 ${RECENT_CHANGES_FEED_URL} 获取最近更新...`);
    
    let browser;
    try {
        console.log('[更新模式] 正在启动浏览器以获取 Feed 内容...');
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.goto(RECENT_CHANGES_FEED_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        let responseText = await page.content();
        console.log('[更新模式] 已成功通过浏览器获取 Feed 页面内容。');

        const $html = cheerio.load(responseText);
        const xmlContainer = $html('#webkit-xml-viewer-source-xml');
        let feedXml = xmlContainer.length ? xmlContainer.html() : responseText;
        
        feedXml = feedXml.replace(/xmlns="[^"]*"/g, '');

        const $ = cheerio.load(feedXml, { xmlMode: true, decodeEntities: false });
        const entries = $('entry');

        if (entries.length === 0) {
            console.error('❌ [更新模式] 错误: Cheerio 未能从提供的 XML 中解析出任何<entry>元素。');
            return [];
        }

        const pagesToConsider = new Map();
        
        entries.each((i, entry) => {
            const $entry = $(entry);
            const originalTitle = $entry.find('title').first().text();
            
            const title = sanitizePageName(originalTitle);

            let alternateLink = null;
            $entry.find('link').each(function() {
                if ($(this).attr('rel') === 'alternate') {
                    alternateLink = $(this).attr('href');
                    return false;
                }
            });

            if (title && alternateLink) {
                const diffMatch = alternateLink.match(/diff=(\d+)/);
                const newRevisionId = diffMatch && diffMatch[1] ? parseInt(diffMatch[1], 10) : null;

                if (newRevisionId && (!pagesToConsider.has(title) || newRevisionId > pagesToConsider.get(title))) {
                    pagesToConsider.set(title, newRevisionId);
                }
            }
        });

        if (pagesToConsider.size === 0) {
            console.log('[更新模式] Feed 中没有找到任何有效的页面更新条目。');
            return [];
        }

        const pagesToUpdate = [];
        console.log(`--- [更新模式] 开始分析 ${pagesToConsider.size} 个独立页面的最新版本 ---`);
        
        for (const [title, newRevisionId] of pagesToConsider.entries()) {
            const blockedPrefixes = ['Special:', 'User:', 'MediaWiki:', 'Help:', 'Category:', 'File:', 'Template:'];
            if (blockedPrefixes.some(p => title.startsWith(p))) {
                console.log(`  - [已跳过] '${title}' (原因: 命名空间被过滤)`);
                continue;
            }
            
            const currentRevisionId = lastEditInfo[title] || 0;
            console.log(`  - [正在比较] '${title}': Feed版本=${newRevisionId}, 本地版本=${currentRevisionId}`);
            
            if (newRevisionId > currentRevisionId) {
                console.log(`      ↳ [结论] 待更新`);
                pagesToUpdate.push(title);
            } else {
                console.log(`      ↳ [结论] 已是最新`);
            }
        }
        
        console.log(`--- [更新模式] Feed分析完成 ---`);

        if (pagesToUpdate.length > 0) {
             console.log(`[更新模式] 最终确定 ${pagesToUpdate.length} 个页面需要更新: ${pagesToUpdate.join(', ')}`);
        } else {
            console.log('[更新模式] 所有有效页面都已是最新版本或被过滤，无需更新。');
        }

        return pagesToUpdate;

    } catch (error) {
        console.error('❌ [更新模式] 处理 Feed 时出错:', error.message);
        return [];
    } finally {
        if (browser) {
            await browser.close();
            console.log('[更新模式] 已关闭用于获取 Feed 的浏览器实例。');
        }
    }
}


async function getPreparedDictionary() { console.log(`正在从 URL 获取文本词典: ${DICTIONARY_URL}`); let originalDict; try { const response = await fetch(DICTIONARY_URL); if (!response.ok) { throw new Error(`网络请求失败: ${response.status}`); } const scriptContent = await response.text(); originalDict = new Function(`${scriptContent}; return replacementDict;`)(); console.log("在线文本词典加载成功。原始大小:", Object.keys(originalDict).length); } catch (error) { console.error("加载或解析在线文本词典时出错。将使用空词典。", error.message); return { fullDictionary: new Map(), sortedKeys: [] }; } const tempDict = { ...originalDict }; for (const key in originalDict) { if (Object.hasOwnProperty.call(originalDict, key)) { const pluralKey = pluralize(key); if (pluralKey !== key && !tempDict.hasOwnProperty(pluralKey)) { tempDict[pluralKey] = originalDict[key]; } } } const fullDictionary = new Map(Object.entries(tempDict)); const sortedKeys = Object.keys(tempDict).sort((a, b) => b.length - a.length); console.log(`文本词典准备完毕。总词条数 (含复数): ${fullDictionary.size}，已按长度排序。`); return { fullDictionary, sortedKeys }; }

function getPreparedSourceDictionary() {
    const filePath = path.resolve(__dirname, SOURCE_DICT_FILE);
    console.log(`正在从本地文件加载源替换词典: ${filePath}`);
    if (!fs.existsSync(filePath)) {
        console.warn(`⚠️ 源替换词典文件未找到: ${SOURCE_DICT_FILE}。将不进行源替换。`);
        return new Map();
    }
    try {
        const scriptContent = fs.readFileSync(filePath, 'utf-8');
        const sourceDict = new Function(`${scriptContent}; return sourceReplacementDict;`)();
        const sourceMap = new Map(Object.entries(sourceDict || {}));
        if (sourceMap.size > 0) {
            console.log(`本地源替换词典加载成功。共 ${sourceMap.size} 条替换规则。`);
        }
        return sourceMap;
    } catch (error) {
        console.error(`❌ 加载或解析本地源替换词典文件 ${SOURCE_DICT_FILE} 时出错。`, error.message);
        return new Map();
    }
}

function replaceTermsDirectly(text, fullDictionary, sortedKeys) { if (!text) return ""; let result = text; for (const key of sortedKeys) { const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const regex = new RegExp(`\\b${escapedKey}\\b`, 'gi'); if (regex.test(result)) { result = result.replace(regex, fullDictionary.get(key)); } } return result; }
function containsEnglish(text) { return /[a-zA-Z]/.test(text); }
async function translateTextWithEnglishCheck(textToTranslate) { if (!textToTranslate || !textToTranslate.trim()) { return ""; } if (!containsEnglish(textToTranslate)) { return textToTranslate; } const MAX_LENGTH = 990; if (textToTranslate.length <= MAX_LENGTH) { for (let attempt = 1; attempt <= BING_TRANSLATE_RETRIES; attempt++) { try { const res = await bingTranslate(textToTranslate, 'en', 'zh-Hans', false); return res?.translation || textToTranslate; } catch (bingError) { console.warn(`[翻译尝试 ${attempt}/${BING_TRANSLATE_RETRIES}] ⚠️ 必应翻译失败 (短文本): ${bingError.message.substring(0, 100)}`); if (attempt >= BING_TRANSLATE_RETRIES) { console.error(`❌ 必应翻译在 ${BING_TRANSLATE_RETRIES} 次尝试后仍然失败。将返回原始文本。`); } else { await new Promise(resolve => setTimeout(resolve, BING_RETRY_DELAY)); } } } return textToTranslate; } console.log(`[文本分割] 检测到超长文本 (长度: ${textToTranslate.length})，将进行分割翻译...`); const sentences = textToTranslate.match(/[^.!?]+[.!?]*\s*/g) || [textToTranslate]; const translatedSentences = []; for (const sentence of sentences) { if (!sentence.trim()) continue; const translatedSentence = await translateTextWithEnglishCheck(sentence); translatedSentences.push(translatedSentence); } const finalResult = translatedSentences.join(''); console.log(`[文本分割] 超长文本翻译完成。`); return finalResult; }
function getPageNameFromWikiLink(href) { if (!href) return null; let url; try { url = new URL(href, BASE_URL); } catch (e) { return null; } if (url.hostname !== new URL(BASE_URL).hostname) { return null; } let pathname = decodeURIComponent(url.pathname); if (pathname.startsWith('/w/index.php')) { return null; } let pageName = pathname.substring(1); const blockedPrefixes = ['Special', 'File', 'User', 'MediaWiki', 'Template', 'Help', 'Category']; const blockedPrefixRegex = new RegExp(`^(${blockedPrefixes.join('|')}):`, 'i'); if (!pageName || blockedPrefixRegex.test(pageName) || pageName.includes('#') || /\.(css|js|png|jpg|jpeg|gif|svg|ico|php)$/i.test(pageName)) { return null; } return sanitizePageName(pageName); }
function findInternalLinks($) { const links = new Set(); $('#mw-content-text a[href]').each((i, el) => { const href = $(el).attr('href'); const pageName = getPageNameFromWikiLink(href); if (pageName) { links.add(pageName); } }); return Array.from(links); }
function createRedirectHtml(targetPageName) { const targetUrl = `./${targetPageName}`; return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>正在重定向...</title><meta http-equiv="refresh" content="0; url=${targetUrl}"><link rel="canonical" href="${targetUrl}"><script>window.location.replace("${targetUrl}");</script></head><body><p>如果您的浏览器没有自动跳转，请 <a href="${targetUrl}">点击这里</a>。</p></body></html>`; }

function findImageReplacement(url, replacementMap) {
    if (!url) return url;
    if (replacementMap.has(url)) {
        return replacementMap.get(url);
    }
    const thumbRegex = /(.*\/images\/\w{2})\/thumb(\/.*?\.\w+)\/\d+px-.*$/i;
    const match = url.match(thumbRegex);
    if (match && match[1] && match[2]) {
        const reconstructedBaseUrl = match[1] + match[2];
        if (replacementMap.has(reconstructedBaseUrl)) {
            return replacementMap.get(reconstructedBaseUrl);
        }
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
    
    console.log(`[${pageNameToProcess}] 页面抓取成功。`);
    const $ = cheerio.load(htmlContent);

    let rlconf = null;
    const rlconfMatch = htmlContent.match(/RLCONF\s*=\s*(\{[\s\S]*?\});/);
    if (rlconfMatch && rlconfMatch[1]) {
        try {
            rlconf = JSON.parse(rlconfMatch[1]);
        } catch (e) {
            console.error(`[${pageNameToProcess}] ❌ 解析RLCONF JSON时出错:`, e.message);
            rlconf = null;
        }
    }

    if (!rlconf) {
        console.warn(`[${pageNameToProcess}] ⚠️ 未能找到或解析RLCONF配置，将跳过此页面。`);
        return null;
    }

    if (rlconf.wgArticleId === 0) {
        console.log(`[${pageNameToProcess}] ❌ 页面不存在 (ArticleID: 0)，跳过处理。`);
        return { links: [] };
    }

    if (rlconf.wgRedirectedFrom && rlconf.wgPageName !== rlconf.wgRedirectedFrom) {
        const sourcePage = sanitizePageName(rlconf.wgRedirectedFrom);
        const targetPage = sanitizePageName(rlconf.wgPageName);
        console.log(`[${sourcePage}] ➡️  发现重定向: [${targetPage}]`);
        const redirectHtml = createRedirectHtml(targetPage);
        fs.writeFileSync(path.join(OUTPUT_DIR, `${sourcePage}.html`), redirectHtml, 'utf-8');
        console.log(`✅ [${sourcePage}] 已创建重定向文件。`);
        return { isRedirect: true, newRedirectInfo: { source: sourcePage, target: targetPage }, links: findInternalLinks($) };
    }

    const currentEditInfo = rlconf.wgCurRevisionId || rlconf.wgRevisionId || null;

    if (!force && currentEditInfo && lastEditInfoState[pageNameToProcess] === currentEditInfo) {
        console.log(`[${pageNameToProcess}] 页面内容未更改 (Revision ID: ${currentEditInfo})。跳过翻译。`);
        return { links: findInternalLinks($) };
    } else if (force) {
        console.log(`[${pageNameToProcess}] 强制模式: 将忽略版本检查并继续处理。`);
    } else if (!currentEditInfo) {
        console.warn(`[${pageNameToProcess}] ⚠️ 未能找到 Revision ID。将继续处理。`);
    }

    const headElements = [];
    $('head').children('link, style, script, meta, title').each(function() {
        const $el = $(this);
        if ($el.is('link')) {
            const href = $el.attr('href');
            if (href && href.startsWith('/')) { $el.attr('href', BASE_URL + href); }
        }
        if ($el.is('script')) {
            const src = $el.attr('src');
            if (src && src.startsWith('/')) { $el.attr('src', BASE_URL + src); }
        }
        if ($el.is('meta')) {
            const content = $el.attr('content');
            if (content) {
                const newContent = findImageReplacement(content, sourceReplacementMap);
                if (content !== newContent) {
                    $el.attr('content', newContent);
                    console.log(`  - [META 替换] '${content.substring(0, 70)}...' 已替换。`);
                }
            }
        }
        headElements.push($.html(this));
    });

    const bodyEndScripts = []; $('body > script').each(function() { const $el = $(this); const src = $el.attr('src'); if (src && src.startsWith('/')) { $el.attr('src', BASE_URL + src); } bodyEndScripts.push($.html(this)); });
    const $contentContainer = $('<div id="wiki-content-wrapper"></div>'); $('#firstHeading').clone().appendTo($contentContainer); $('#mw-content-text .mw-parser-output').children().each(function() { $contentContainer.append($(this).clone()); });
    const $factBoxContent = $contentContainer.find('.random-text-box > div:last-child'); if ($factBoxContent.length > 0) { $factBoxContent.html('<p id="dynamic-fact-placeholder" style="margin:0;">正在加载有趣的事实...</p>'); const factScript = `<script>document.addEventListener('DOMContentLoaded', function() { const factsUrl = './facts.json'; const placeholder = document.getElementById('dynamic-fact-placeholder'); if (placeholder) { fetch(factsUrl).then(response => { if (!response.ok) { throw new Error('网络响应错误，状态码: ' + response.status); } return response.json(); }).then(facts => { if (facts && Array.isArray(facts) && facts.length > 0) { const randomIndex = Math.floor(Math.random() * facts.length); const randomFact = facts[randomIndex].cn; placeholder.innerHTML = randomFact; } else { placeholder.innerHTML = '暂时没有可显示的事实。'; } }).catch(error => { console.error('加载或显示事实时出错:', error); placeholder.innerHTML = '加载事实失败，请稍后再试。'; }); } });<\/script>`; bodyEndScripts.push(factScript); }
    const originalTitle = $('title').text() || pageNameToProcess; const preReplacedTitle = replaceTermsDirectly(originalTitle, fullDictionary, sortedKeys); let translatedTitle = await translateTextWithEnglishCheck(preReplacedTitle); translatedTitle = translatedTitle.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3'); $contentContainer.find('a').each(function() { const $el = $(this); const originalHref = $el.attr('href'); const internalPageName = getPageNameFromWikiLink(originalHref); if (internalPageName) { $el.attr('href', `./${internalPageName}`); } else if (originalHref && !originalHref.startsWith('#')) { try { $el.attr('href', new URL(originalHref, sourceUrl).href); } catch (e) { console.warn(`[${pageNameToProcess}] 转换外部链接 'a' href 时出错: ${originalHref}`); } } });
    
    $contentContainer.find('img').each(function() {
        const $el = $(this);
        let src = $el.attr('src');
        if (src) {
            try {
                const absoluteSrc = new URL(src, sourceUrl).href;
                const replacementSrc = findImageReplacement(absoluteSrc, sourceReplacementMap);
                $el.attr('src', replacementSrc);
            } catch (e) { console.warn(`[${pageNameToProcess}] 转换 img src 时出错: ${src}`); }
        }
        const srcset = $el.attr('srcset');
        if (srcset) {
            const newSrcset = srcset.split(',').map(s => {
                const parts = s.trim().split(/\s+/);
                let urlPart = parts[0];
                const descriptor = parts.length > 1 ? ` ${parts[1]}` : '';
                try {
                    const absoluteUrl = new URL(urlPart, sourceUrl).href;
                    const replacementUrl = findImageReplacement(absoluteUrl, sourceReplacementMap);
                    return replacementUrl + descriptor;
                } catch(e) { console.warn(`[${pageNameToProcess}] 转换 srcset URL 时出错: ${urlPart}`); return s; }
            }).join(', ');
            $el.attr('srcset', newSrcset);
        }
    });

    $contentContainer.find('iframe').each(function() {
        const $el = $(this);
        let src = $el.attr('src');
        if (src) {
             try {
                 const absoluteUrl = new URL(src, sourceUrl).href;
                 const replacementSrc = findImageReplacement(absoluteUrl, sourceReplacementMap);
                 if (absoluteUrl !== replacementSrc) {
                     $el.attr('src', replacementSrc);
                     console.log(`[${pageNameToProcess}] ✅ Iframe src 替换成功: ${absoluteUrl}`);
                 } else { $el.attr('src', absoluteUrl); }
             } catch(e) { console.warn(`[${pageNameToProcess}] 转换 iframe src 属性时出错: ${src}`); }
        }
    });

    console.log(`[${pageNameToProcess}] 正在查找并替换 YouTube 视频链接的 data-id...`);
    $contentContainer.find('.ShowYouTubePopup[data-id]').each(function() {
        const $el = $(this);
        const yid = $el.attr('data-id');
        if (!yid) return;
        let replaced = false;
        if (sourceReplacementMap.has(yid)) {
            const bvid = sourceReplacementMap.get(yid);
            $el.attr('data-id', bvid);
            console.log(`  - ✅ [data-id] (通过ID) 替换成功: ${yid} -> ${bvid}`);
            replaced = true;
        } else {
            const youtubeUrl = `https://www.youtube.com/embed/${yid}`;
            if (sourceReplacementMap.has(youtubeUrl)) {
                const bilibiliPlayerUrl = sourceReplacementMap.get(youtubeUrl);
                try {
                    const url = new URL(bilibiliPlayerUrl);
                    const bvid = url.searchParams.get('bvid');
                    if (bvid) {
                        $el.attr('data-id', bvid);
                        console.log(`  - ✅ [data-id] (通过URL) 替换成功: ${yid} -> ${bvid}`);
                        replaced = true;
                    } else { console.warn(`  - ⚠️ 在目标URL ${bilibiliPlayerUrl} 中未找到 BVID。`); }
                } catch (e) { console.warn(`  - ⚠️ 解析Bilibili URL时出错: ${bilibiliPlayerUrl}`); }
            }
        }
        if (!replaced) { console.log(`  - [未替换] data-id="${yid}" 在源替换词典中未找到对应规则。`); }
    });
    
    const textNodes = []; $contentContainer.find('*:not(script,style)').addBack().contents().each(function() { if (this.type === 'text' && this.data.trim() && !$(this).parent().is('span.hotkey')) { textNodes.push(this); } });
    const textPromises = textNodes.map(node => { const preReplaced = replaceTermsDirectly(node.data, fullDictionary, sortedKeys); return translateTextWithEnglishCheck(preReplaced); }); const translatedTexts = await Promise.all(textPromises);
    textNodes.forEach((node, index) => { if (translatedTexts[index]) { node.data = translatedTexts[index].trim(); } });
    const elementsWithAttributes = $contentContainer.find('[title], [alt]'); for (let i = 0; i < elementsWithAttributes.length; i++) { const $element = $(elementsWithAttributes[i]); for (const attr of ['title', 'alt']) { const originalValue = $element.attr(attr); if (originalValue) { const preReplaced = replaceTermsDirectly(originalValue, fullDictionary, sortedKeys); const translatedValue = await translateTextWithEnglishCheck(preReplaced); $element.attr(attr, translatedValue); } } }
    
    let finalHtmlContent = $contentContainer.html();
    // 【修改】移除了服务器端的颜色替换，只保留中文之间的空格清理
    finalHtmlContent = finalHtmlContent.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3');

    let homeButtonHtml = ''; if (pageNameToProcess !== START_PAGE) { homeButtonHtml = `<a href="./${START_PAGE}" style="display: inline-block; margin: 0 0 25px 0; padding: 12px 24px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 8px; font-family: 'Rubik', 'M PLUS 1p', sans-serif; transition: background-color 0.3s ease, transform 0.2s ease; box-shadow: 0 4px 8px rgba(0,0,0,0.2);" onmouseover="this.style.backgroundColor='#a8c0e0'; this.style.transform='scale(1.03)';" onmouseout="this.style.backgroundColor='#BFD5FF'; this.style.transform='scale(1)';">返回主页</a>`; }
    
    // 【新增】定义用于注入的颜色替换脚本
    const colorReplacementScript = `
    <script>
    // 客户端颜色替换逻辑
    function replaceColorsInDom() {
        // 定义替换规则
        const replacements = [
            { from: /#?46DF11|rgb\\(70,\\s*223,\\s*17\\)/gi, to: '#76FF33' },
            { from: /#?00D7FF/gi, to: '#00D4FF' },
            { from: /#?(F86667|F33|FF3333)\\b/gi, to: '#FF6666' },
            { from: /#?(FC0|FFCC00)\\b/gi, to: '#FFEE00' },
            { from: /#?8C60EB/gi, to: '#D580FF' }
        ];

        // 辅助函数，应用所有替换规则
        function applyReplacements(text) {
            if (!text) return text;
            let newText = text;
            for (const rule of replacements) {
                newText = newText.replace(rule.from, rule.to);
            }
            return newText;
        }

        // 1. 替换所有元素的内联样式 (style attribute)
        document.querySelectorAll('[style]').forEach(el => {
            const originalStyle = el.getAttribute('style');
            const newStyle = applyReplacements(originalStyle);
            if (newStyle !== originalStyle) {
                el.setAttribute('style', newStyle);
            }
        });

        // 2. 替换页面内 <style> 标签中的样式规则
        document.querySelectorAll('style').forEach(styleTag => {
            const originalCss = styleTag.innerHTML;
            const newCss = applyReplacements(originalCss);
            if (newCss !== originalCss) {
                styleTag.innerHTML = newCss;
            }
        });
    }

    // 在DOM加载完成后立即执行，以尽量减少颜色闪烁
    document.addEventListener('DOMContentLoaded', replaceColorsInDom);
    <\/script>
    `;
    bodyEndScripts.push(colorReplacementScript);


    const bilibiliPopupScript = `
    <script>
    // Bilibili 弹窗逻辑 (V4 - 精确复刻)
    document.addEventListener('DOMContentLoaded', function() {
        const videoPopups = document.querySelectorAll('.ShowYouTubePopup');
        if (videoPopups.length) {
            let modal = null;
            videoPopups.forEach(popup => {
                if (popup.dataset.biliHandled) return;
                
                popup.addEventListener('click', (event) => {
                    event.stopImmediatePropagation(); 

                    if (typeof tingle === 'undefined') {
                        console.error('Tingle.js 未加载，无法打开视频弹窗。');
                        return;
                    }
                    showBilibiliModal(popup.dataset.id);
                }, true);

                popup.dataset.biliHandled = 'true';
            });

            function showBilibiliModal(bvid) {
                modal = new tingle.modal({
                    closeMethods: ['button', 'escape', 'overlay']
                });
                modal.setContent(\`
                        <div class="report-head">
                            <div class="report-title">观看视频</div>
                            <div class="report-stripes"></div>
                            <div class="report-close"></div>
                        </div>
                        
                        <div style="margin: 15px 10px 10px 10px; background: url('loading.gif') center no-repeat;">
                            <iframe class="yt-video" width="640px" height="360px"
                                src="https://player.bilibili.com/player.html?bvid=\${bvid}" 
                                frameborder="0" 
                                allowfullscreen="allowfullscreen"
                                sandbox="allow-top-navigation allow-same-origin allow-forms allow-scripts">
                            </iframe>
                        </div>
                    \`);
                modal.open();

                const closeButton = modal.getContent().querySelector('.report-close');
                closeButton.addEventListener('click', () => modal.close());

                const tingleClose = modal.modal.querySelector('.tingle-modal__close');
                if (tingleClose) tingleClose.remove();
            }
        }
    });
    <\/script>
    `;
    bodyEndScripts.push(bilibiliPopupScript);
    
    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    '); const bodyClasses = $('body').attr('class') || ''; const finalHtml = `<!DOCTYPE html><html lang="zh-CN" dir="ltr"><head><meta charset="UTF-8"><title>${translatedTitle}</title>${headContent}<style>@import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');body{font-family:'Rubik','M PLUS 1p',sans-serif;background-color:#001926 !important;}#mw-main-container{max-width:1200px;margin:20px auto;background-color:#001926;padding:20px;}</style></head><body class="${bodyClasses}"><div id="mw-main-container">${homeButtonHtml}<div class="main-content"><div class="mw-body ve-init-mw-desktopArticleTarget-targetContainer" id="content" role="main"><a id="top"></a><div class="mw-body-content" id="bodyContent"><div id="siteNotice"></div><div id="mw-content-text" class="mw-content-ltr mw-parser-output" lang="zh-CN" dir="ltr">${finalHtmlContent}</div></div></div></div></div>${bodyEndScripts.join('\n    ')}</body></html>`;
    
    fs.writeFileSync(path.join(OUTPUT_DIR, `${pageNameToProcess}.html`), finalHtml, 'utf-8');
    
    console.log(`✅ [${pageNameToProcess}] 翻译完成 (Revision ID: ${currentEditInfo})！文件已保存到 output 目录。`);
    return { translationResult: { pageName: pageNameToProcess, newEditInfo: currentEditInfo }, links: findInternalLinks($) };
}

async function run() {
    console.log("--- 翻译任务开始 ---");

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR);
        console.log(`创建输出目录: ${OUTPUT_DIR}`);
    }

    const sourceReplacementMap = getPreparedSourceDictionary();
    const { fullDictionary, sortedKeys } = await getPreparedDictionary();
    
    let lastEditInfo = {};
    if (fs.existsSync(EDIT_INFO_FILE)) {
        try {
            lastEditInfo = JSON.parse(fs.readFileSync(EDIT_INFO_FILE, 'utf-8'));
            console.log(`已成功加载上次的编辑信息记录。`);
        } catch (e) { console.error(`❌ 读取或解析 ${EDIT_INFO_FILE} 时出错，将作为首次运行处理。`); }
    }
    let redirectMap = {};
    if (fs.existsSync(REDIRECT_MAP_FILE)) {
        try {
            redirectMap = JSON.parse(fs.readFileSync(REDIRECT_MAP_FILE, 'utf-8'));
            console.log(`已成功加载现有的重定向地图。`);
        } catch (e) { console.error(`❌ 读取或解析 ${REDIRECT_MAP_FILE} 时出错，将使用空地图开始。`); }
    }

    const runMode = (process.env.RUN_MODE || 'FEED').toUpperCase();
    let pagesToVisit = [];
    
    console.log(`========================================`);
    console.log(`     当前运行模式: ${runMode}`);
    console.log(`========================================`);

    switch (runMode) {
        case 'FEED':
            pagesToVisit = await getPagesForFeedMode(lastEditInfo);
            break;
        case 'CRAWLER':
            console.log(`[爬虫模式] 从起始页 ${START_PAGE} 开始爬取。`);
            pagesToVisit = [START_PAGE];
            break;
        case 'SPECIFIED':
            const pagesEnv = process.env.PAGES_TO_PROCESS;
            if (!pagesEnv) {
                console.warn('[指定模式] 未提供 PAGES_TO_PROCESS 环境变量，任务结束。');
                return;
            }
            pagesToVisit = pagesEnv.split(',').map(p => sanitizePageName(p.trim())).filter(Boolean);
            console.log(`[指定模式] 将强制处理以下页面: ${pagesToVisit.join(', ')}`);
            break;
        default:
            console.error(`❌ 未知的运行模式: ${runMode}。将使用默认的 FEED 模式。`);
            pagesToVisit = await getPagesForFeedMode(lastEditInfo);
            break;
    }

    if (pagesToVisit.length === 0) {
        console.log("没有需要处理的页面，任务提前结束。");
        return;
    }
    
    console.log(`[任务开始] 准备处理 ${pagesToVisit.length} 个页面...`);

    const visitedPages = new Set();
    let activeTasks = 0;
    let pageIndex = 0;
    
    const isForceMode = runMode === 'FEED' || runMode === 'SPECIFIED';

    while (pageIndex < pagesToVisit.length) {
        const promises = [];
        
        while (activeTasks < CONCURRENCY_LIMIT && pageIndex < pagesToVisit.length) {
            const currentPageName = pagesToVisit[pageIndex++];
            if (visitedPages.has(currentPageName)) continue;
            
            visitedPages.add(currentPageName);
            activeTasks++;

            const task = processPage(currentPageName, fullDictionary, sortedKeys, sourceReplacementMap, lastEditInfo, isForceMode)
                .then(result => {
                    if (result) {
                        if (result.newRedirectInfo) {
                            redirectMap[result.newRedirectInfo.source] = result.newRedirectInfo.target;
                        }
                        if (result.translationResult) {
                            lastEditInfo[result.translationResult.pageName] = result.translationResult.newEditInfo;
                        }
                        if (runMode === 'CRAWLER' && result.links && result.links.length > 0) {
                            for (const link of result.links) {
                                if (!visitedPages.has(link) && !pagesToVisit.includes(link)) {
                                    pagesToVisit.push(link);
                                }
                            }
                        }
                    }
                })
                .catch(err => {
                    console.error(`处理页面 ${currentPageName} 时发生未捕获的错误:`, err);
                })
                .finally(() => {
                    activeTasks--;
                });
            
            promises.push(task);
        }
        
        await Promise.all(promises);
        const totalPages = runMode === 'CRAWLER' ? pagesToVisit.length : visitedPages.size;
        console.log(`--- [进度] 已处理 ${visitedPages.size} / ${totalPages} 个页面 ---`);
    }

    console.log('即将写入 redirect_map.json，当前内存中的内容为:');
    console.log(JSON.stringify(redirectMap, null, 2));

    try {
        fs.writeFileSync(EDIT_INFO_FILE, JSON.stringify(lastEditInfo, null, 2), 'utf-8');
        console.log(`✅ 成功将最新的编辑信息保存到 ${EDIT_INFO_FILE}`);

        fs.writeFileSync(REDIRECT_MAP_FILE, JSON.stringify(redirectMap, null, 2), 'utf-8');
        console.log(`✅ 成功将最新的重定向地图保存到 ${REDIRECT_MAP_FILE}`);
    } catch (e) {
        console.error('❌ 写入状态文件时出错:', e);
    }
    
    console.log("--- 所有页面处理完毕，任务结束！ ---");
}

run().catch(console.error);
