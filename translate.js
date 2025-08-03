// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { translate: bingTranslate } = require('bing-translate-api');
const pluralize = require('pluralize');
const fs = require('fs');
const path = require('path');

// --- 【配置常量】 ---
const BASE_URL = 'https://en.tankiwiki.com';
const START_PAGE = 'Tanki_Online_Wiki';
const CONCURRENCY_LIMIT = 32;
const DICTIONARY_URL = 'https://testanki1.github.io/translations.js';
const IMAGE_DICT_FILE = 'image_replacements.js';
const OUTPUT_DIR = './output';
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');
const REDIRECT_MAP_FILE = path.join(__dirname, 'redirect_map.json');
const BING_TRANSLATE_RETRIES = 5;
const BING_RETRY_DELAY = 1500;

// --- 1. 准备文本翻译词典 (从网络 URL) ---
async function getPreparedDictionary() {
    console.log(`正在从 URL 获取文本词典: ${DICTIONARY_URL}`);
    let originalDict;
    try {
        const response = await fetch(DICTIONARY_URL);
        if (!response.ok) { throw new Error(`网络请求失败: ${response.status}`); }
        const scriptContent = await response.text();
        originalDict = new Function(`${scriptContent}; return replacementDict;`)();
        console.log("在线文本词典加载成功。原始大小:", Object.keys(originalDict).length);
    } catch (error) {
        console.error("加载或解析在线文本词典时出错。将使用空词典。", error.message);
        return { fullDictionary: new Map(), sortedKeys: [] };
    }

    const tempDict = { ...originalDict };
    for (const key in originalDict) {
        if (Object.hasOwnProperty.call(originalDict, key)) {
            const pluralKey = pluralize(key);
            if (pluralKey !== key && !tempDict.hasOwnProperty(pluralKey)) {
                tempDict[pluralKey] = originalDict[key];
            }
        }
    }
    
    const fullDictionary = new Map(Object.entries(tempDict));
    const sortedKeys = Object.keys(tempDict).sort((a, b) => b.length - a.length);
    console.log(`文本词典准备完毕。总词条数 (含复数): ${fullDictionary.size}，已按长度排序。`);
    return { fullDictionary, sortedKeys };
}

// --- 准备图片替换词典 (从本地文件) ---
function getPreparedImageDictionary() {
    const filePath = path.resolve(__dirname, IMAGE_DICT_FILE);
    console.log(`正在从本地文件加载图片词典: ${filePath}`);
    if (!fs.existsSync(filePath)) {
        console.warn(`⚠️ 图片词典文件未找到: ${IMAGE_DICT_FILE}。将不进行图片替换。`);
        return new Map();
    }
    try {
        const scriptContent = fs.readFileSync(filePath, 'utf-8');
        const imageDict = new Function(`${scriptContent}; return imageReplacementDict;`)();
        const imageMap = new Map(Object.entries(imageDict || {}));
        if (imageMap.size > 0) {
             console.log(`本地图片词典加载成功。共 ${imageMap.size} 条替换规则。`);
        }
        return imageMap;
    } catch (error) {
        console.error(`❌ 加载或解析本地图片词典文件 ${IMAGE_DICT_FILE} 时出错。`, error.message);
        return new Map();
    }
}

// --- 2. 直接替换函数 ---
function replaceTermsDirectly(text, fullDictionary, sortedKeys) {
    if (!text) return "";
    let result = text;
    for (const key of sortedKeys) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedKey}\\b`, 'gi');
        if (regex.test(result)) {
            result = result.replace(regex, fullDictionary.get(key));
        }
    }
    return result;
}

// --- 3. 检测是否包含英文字母的函数 ---
function containsEnglish(text) {
    return /[a-zA-Z]/.test(text);
}

// --- 4. 带英文检测、长度分割和重试的翻译函数 ---
async function translateTextWithEnglishCheck(textToTranslate) {
    if (!textToTranslate || !textToTranslate.trim()) { return ""; }
    if (!containsEnglish(textToTranslate)) { return textToTranslate; }
    const MAX_LENGTH = 990;
    if (textToTranslate.length <= MAX_LENGTH) {
        for (let attempt = 1; attempt <= BING_TRANSLATE_RETRIES; attempt++) {
            try {
                const res = await bingTranslate(textToTranslate, 'en', 'zh-Hans', false);
                return res?.translation || textToTranslate;
            } catch (bingError) {
                console.warn(`[翻译尝试 ${attempt}/${BING_TRANSLATE_RETRIES}] ⚠️ 必应翻译失败 (短文本): ${bingError.message.substring(0, 100)}`);
                if (attempt >= BING_TRANSLATE_RETRIES) {
                    console.error(`❌ 必应翻译在 ${BING_TRANSLATE_RETRIES} 次尝试后仍然失败。将返回原始文本。`);
                } else {
                    await new Promise(resolve => setTimeout(resolve, BING_RETRY_DELAY));
                }
            }
        }
        return textToTranslate;
    }
    console.log(`[文本分割] 检测到超长文本 (长度: ${textToTranslate.length})，将进行分割翻译...`);
    const sentences = textToTranslate.match(/[^.!?]+[.!?]*\s*/g) || [textToTranslate];
    const translatedSentences = [];
    for (const sentence of sentences) {
        if (!sentence.trim()) continue;
        const translatedSentence = await translateTextWithEnglishCheck(sentence);
        translatedSentences.push(translatedSentence);
    }
    const finalResult = translatedSentences.join('');
    console.log(`[文本分割] 超长文本翻译完成。`);
    return finalResult;
}

// --- 【核心修改点】辅助函数：使用更智能的规则过滤链接 ---
function getPageNameFromWikiLink(href) {
    if (!href) return null;

    let url;
    try {
        url = new URL(href, BASE_URL);
    } catch (e) {
        return null;
    }

    if (url.hostname !== new URL(BASE_URL).hostname) {
        return null;
    }

    let pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/w/index.php')) {
        return null;
    }
    
    let pageName = pathname.substring(1);

    // 定义我们不希望处理的页面命名空间前缀
    const blockedPrefixes = ['Special', 'File', 'User', 'MediaWiki', 'Template', 'Help', 'Category'];
    // 创建一个正则表达式，检查 pageName 是否以任何一个被阻止的前缀开头
    // 例如: /^(Special|File|User|...):/i
    const blockedPrefixRegex = new RegExp(`^(${blockedPrefixes.join('|')}):`, 'i');

    if (
        !pageName ||
        blockedPrefixRegex.test(pageName) || // <--- 使用新的、更智能的规则
        pageName.includes('#') ||
        /\.(css|js|png|jpg|jpeg|gif|svg|ico|php)$/i.test(pageName)
    ) {
        return null;
    }

    return pageName;
}

// --- 查找页面内符合条件的链接 ---
function findInternalLinks($) {
    const links = new Set();
    $('#mw-content-text a[href]').each((i, el) => {
        const href = $(el).attr('href');
        const pageName = getPageNameFromWikiLink(href);
        if (pageName) {
            links.add(pageName);
        }
    });
    return Array.from(links);
}

// --- 创建一个简单的HTML重定向页面 ---
function createRedirectHtml(targetPageName) {
    const targetUrl = `./${targetPageName}`;
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>正在重定向...</title><meta http-equiv="refresh" content="0; url=${targetUrl}"><link rel="canonical" href="${targetUrl}"><script>window.location.replace("${targetUrl}");</script></head><body><p>如果您的浏览器没有自动跳转，请 <a href="${targetUrl}">点击这里</a>。</p></body></html>`;
}

// --- 5. 翻译单个页面的核心函数 ---
async function processPage(pageNameToProcess, fullDictionary, sortedKeys, imageReplacementMap, lastEditInfoState, existingRedirectMap, forceTranslateList = []) {
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
        const sourcePage = rlconf.wgRedirectedFrom;
        const targetPage = rlconf.wgPageName;
        
        console.log(`[${sourcePage}] ➡️  发现重定向: [${targetPage}]`);
        const redirectHtml = createRedirectHtml(targetPage);
        fs.writeFileSync(path.join(OUTPUT_DIR, `${sourcePage}.html`), redirectHtml, 'utf-8');
        console.log(`✅ [${sourcePage}] 已创建重定向文件。`);
        return { isRedirect: true, newRedirectInfo: { source: sourcePage, target: targetPage }, links: findInternalLinks($) };
    }
    
    const isForced = forceTranslateList.includes(pageNameToProcess);
    const currentEditInfo = rlconf.wgCurRevisionId || rlconf.wgRevisionId || null;

    if (isForced) {
        console.log(`[${pageNameToProcess}] 强制翻译模式: 将忽略编辑信息检查并继续处理。`);
    } else if (currentEditInfo && lastEditInfoState[pageNameToProcess] === currentEditInfo) {
        console.log(`[${pageNameToProcess}] 页面内容未更改 (Revision ID: ${currentEditInfo})。跳过翻译。`);
        return { links: findInternalLinks($) };
    } else if (!currentEditInfo) {
        console.warn(`[${pageNameToProcess}] ⚠️ 未能找到 Revision ID。将继续处理。`);
    }

    const headElements = [];
    $('head').children('link, style, script, meta, title').each(function() {
        const $el = $(this);
        if ($el.is('link')) { const href = $el.attr('href'); if (href && href.startsWith('/')) { $el.attr('href', BASE_URL + href); } }
        if ($el.is('script')) { const src = $el.attr('src'); if (src && src.startsWith('/')) { $el.attr('src', BASE_URL + src); } }
        headElements.push($.html(this));
    });

    const bodyEndScripts = [];
    $('body > script').each(function() {
        const $el = $(this);
        const src = $el.attr('src'); if (src && src.startsWith('/')) { $el.attr('src', BASE_URL + src); }
        bodyEndScripts.push($.html(this));
    });
    
    const $contentContainer = $('<div id="wiki-content-wrapper"></div>');
    $('#firstHeading').clone().appendTo($contentContainer);
    $('#mw-content-text .mw-parser-output').children().each(function() { $contentContainer.append($(this).clone()); });

    const $factBoxContent = $contentContainer.find('.random-text-box > div:last-child');
    if ($factBoxContent.length > 0) {
        $factBoxContent.html('<p id="dynamic-fact-placeholder" style="margin:0;">正在加载有趣的事实...</p>');
        const factScript = `<script>document.addEventListener('DOMContentLoaded', function() { const factsUrl = './facts.json'; const placeholder = document.getElementById('dynamic-fact-placeholder'); if (placeholder) { fetch(factsUrl).then(response => { if (!response.ok) { throw new Error('网络响应错误，状态码: ' + response.status); } return response.json(); }).then(facts => { if (facts && Array.isArray(facts) && facts.length > 0) { const randomIndex = Math.floor(Math.random() * facts.length); const randomFact = facts[randomIndex].cn; placeholder.innerHTML = randomFact; } else { placeholder.innerHTML = '暂时没有可显示的事实。'; } }).catch(error => { console.error('加载或显示事实时出错:', error); placeholder.innerHTML = '加载事实失败，请稍后再试。'; }); } });</script>`;
        bodyEndScripts.push(factScript);
    }

    const originalTitle = $('title').text() || pageNameToProcess;
    const preReplacedTitle = replaceTermsDirectly(originalTitle, fullDictionary, sortedKeys);
    let translatedTitle = await translateTextWithEnglishCheck(preReplacedTitle);
    translatedTitle = translatedTitle.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3');

    $contentContainer.find('a').each(function() {
        const $el = $(this);
        const originalHref = $el.attr('href');
        const internalPageName = getPageNameFromWikiLink(originalHref);

        if (internalPageName) {
            $el.attr('href', `./${internalPageName}`);
        } else if (originalHref?.startsWith('/') && !originalHref.startsWith('//')) {
            try {
                $el.attr('href', new URL(originalHref, BASE_URL).href);
            } catch (e) {
                console.warn(`[${pageNameToProcess}] 转换内部资源链接时出错: ${originalHref}`);
            }
        }
    });

    $contentContainer.find('img').each(function() {
        const $el = $(this); let src = $el.attr('src'); if (src) { const absoluteSrc = src.startsWith('/') ? BASE_URL + src : src; if (imageReplacementMap.has(absoluteSrc)) { $el.attr('src', imageReplacementMap.get(absoluteSrc)); } else if (src.startsWith('/')) { $el.attr('src', absoluteSrc); } }
        const srcset = $el.attr('srcset'); if (srcset) { const newSrcset = srcset.split(',').map(s => { const parts = s.trim().split(/\s+/); let url = parts[0]; const descriptor = parts.length > 1 ? ` ${parts[1]}` : ''; const absoluteUrl = url.startsWith('/') ? BASE_URL + url : url; if (imageReplacementMap.has(absoluteUrl)) { return imageReplacementMap.get(absoluteUrl) + descriptor; } return (url.startsWith('/') ? absoluteUrl : url) + descriptor; }).join(', '); $el.attr('srcset', newSrcset); }
    });
    
    const textNodes = [];
    $contentContainer.find('*:not(script,style)').addBack().contents().each(function() { if (this.type === 'text' && this.data.trim() && !$(this).parent().is('span.hotkey')) { textNodes.push(this); } });
    
    const textPromises = textNodes.map(node => { 
        const preReplaced = replaceTermsDirectly(node.data, fullDictionary, sortedKeys);
        return translateTextWithEnglishCheck(preReplaced); 
    });
    const translatedTexts = await Promise.all(textPromises);
    textNodes.forEach((node, index) => { if (translatedTexts[index]) { node.data = translatedTexts[index].trim(); } });

    const elementsWithAttributes = $contentContainer.find('[title], [alt]');
    for (let i = 0; i < elementsWithAttributes.length; i++) {
        const $element = $(elementsWithAttributes[i]);
        for (const attr of ['title', 'alt']) { 
            const originalValue = $element.attr(attr); 
            if (originalValue) { 
                const preReplaced = replaceTermsDirectly(originalValue, fullDictionary, sortedKeys); 
                const translatedValue = await translateTextWithEnglishCheck(preReplaced); 
                $element.attr(attr, translatedValue); 
            } 
        }
    }
    
    let finalHtmlContent = $contentContainer.html();
    finalHtmlContent = finalHtmlContent.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3').replace(/rgb\(70, 223, 17\)/g, '#76FF33');
    
    let homeButtonHtml = '';
    if (pageNameToProcess !== START_PAGE) {
        homeButtonHtml = `<a href="./${START_PAGE}" style="display: inline-block; margin: 0 0 25px 0; padding: 12px 24px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 8px; font-family: 'Rubik', 'M PLUS 1p', sans-serif; transition: background-color 0.3s ease, transform 0.2s ease; box-shadow: 0 4px 8px rgba(0,0,0,0.2);" onmouseover="this.style.backgroundColor='#a8c0e0'; this.style.transform='scale(1.03)';" onmouseout="this.style.backgroundColor='#BFD5FF'; this.style.transform='scale(1)';">返回主页</a>`;
    }
    
    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    ');
    const bodyClasses = $('body').attr('class') || '';
    const finalHtml = `<!DOCTYPE html><html lang="zh-CN" dir="ltr"><head><meta charset="UTF-8"><title>${translatedTitle}</title>${headContent}<style>@import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');body{font-family:'Rubik','M PLUS 1p',sans-serif;background-color:#001926 !important;}#mw-main-container{max-width:1200px;margin:20px auto;background-color:#001926;padding:20px;}</style></head><body class="${bodyClasses}"><div id="mw-main-container">${homeButtonHtml}<div class="main-content"><div class="mw-body ve-init-mw-desktopArticleTarget-targetContainer" id="content" role="main"><a id="top"></a><div class="mw-body-content" id="bodyContent"><div id="siteNotice"></div><div id="mw-content-text" class="mw-content-ltr mw-parser-output" lang="zh-CN" dir="ltr">${finalHtmlContent}</div></div></div></div></div>${bodyEndScripts.join('\n    ')}</body></html>`;
    
    fs.writeFileSync(path.join(OUTPUT_DIR, `${pageNameToProcess}.html`), finalHtml, 'utf-8');
    console.log(`✅ [${pageNameToProcess}] 翻译完成 (Revision ID: ${currentEditInfo})！文件已保存到 output 目录。`);

    return { 
        translationResult: { pageName: pageNameToProcess, newEditInfo: currentEditInfo },
        links: findInternalLinks($)
    };
}


// --- 6. 主运行函数 ---
async function run() {
    console.log("--- 翻译任务开始 (爬虫模式) ---");

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR);
        console.log(`创建输出目录: ${OUTPUT_DIR}`);
    }

    const imageReplacementMap = getPreparedImageDictionary();
    const { fullDictionary, sortedKeys } = await getPreparedDictionary();
    
    let lastEditInfo = {};
    if (fs.existsSync(EDIT_INFO_FILE)) {
        try {
            lastEditInfo = JSON.parse(fs.readFileSync(EDIT_INFO_FILE, 'utf-8'));
            console.log(`已成功加载上次的编辑信息记录。`);
        } catch (e) {
            console.error(`❌ 读取或解析 ${EDIT_INFO_FILE} 时出错，将作为首次运行处理。`);
        }
    }

    let redirectMap = {};
    if (fs.existsSync(REDIRECT_MAP_FILE)) {
        try {
            redirectMap = JSON.parse(fs.readFileSync(REDIRECT_MAP_FILE, 'utf-8'));
            console.log(`已成功加载现有的重定向地图。`);
        } catch (e) {
            console.error(`❌ 读取或解析 ${REDIRECT_MAP_FILE} 时出错，将使用空地图开始。`);
        }
    }

    const pagesToVisit = [START_PAGE];
    const visitedPages = new Set();
    const forceTranslateList = [];

    let activeTasks = 0;
    let pageIndex = 0;

    while (pageIndex < pagesToVisit.length) {
        const promises = [];
        
        while (activeTasks < CONCURRENCY_LIMIT && pageIndex < pagesToVisit.length) {
            const currentPageName = pagesToVisit[pageIndex++];
            if (visitedPages.has(currentPageName)) {
                continue;
            }
            
            visitedPages.add(currentPageName);
            activeTasks++;

            const task = processPage(currentPageName, fullDictionary, sortedKeys, imageReplacementMap, lastEditInfo, redirectMap, forceTranslateList)
                .then(result => {
                    if (result) {
                        if (result.newRedirectInfo) {
                            redirectMap[result.newRedirectInfo.source] = result.newRedirectInfo.target;
                        }
                        if (result.translationResult) {
                            lastEditInfo[result.translationResult.pageName] = result.translationResult.newEditInfo;
                        }
                        if (result.links && result.links.length > 0) {
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
        console.log(`--- [进度] 已处理 ${visitedPages.size} / ${pagesToVisit.length} 个页面 ---`);
    }

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
