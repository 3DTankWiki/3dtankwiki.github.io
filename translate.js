// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { translate: googleTranslate } = require('@vitalets/google-translate-api');
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
        const regex = new RegExp(`\\b${key}\\b`, 'gi');
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

// --- 4. 带英文检测的翻译函数 ---
async function translateTextWithEnglishCheck(textToTranslate) {
    if (!textToTranslate || !textToTranslate.trim()) { return ""; }
    if (!containsEnglish(textToTranslate)) { return textToTranslate; }

    try {
        const res = await bingTranslate(textToTranslate, 'en', 'zh-Hans', false);
        return res.translation;
    } catch (bingError) {
        console.warn(`⚠️ 必应翻译失败 (回退到谷歌): ${bingError.message.substring(0, 100)}`);
        try {
            const res = await googleTranslate(textToTranslate, { from: 'en', to: 'zh-CN' });
            return res.text;
        } catch (googleError) {
            console.error(`❌ 谷歌翻译也失败了。将返回原始文本。`);
            return textToTranslate;
        }
    }
}

// --- 【修改】辅助函数：从链接中提取可处理的页面名称 ---
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

    // 【核心修改】根据您的要求，如果链接路径是 /index.php (通常带有 ?title=... 查询)，则完全忽略该链接。
    if (pathname.endsWith('/index.php')) {
        return null;
    }
    
    // 剩下的逻辑只处理 /PageName 这种“干净”的链接格式
    let pageName = pathname.substring(1);

    // 过滤掉特殊页面、锚点和文件链接
    if (
        !pageName ||
        pageName.includes(':') ||
        pageName.includes('#') ||
        /\.(css|js|png|jpg|jpeg|gif|svg|ico|php)$/i.test(pageName)
    ) {
        return null;
    }

    return pageName;
}

// --- 查找页面内符合条件的链接 (此函数无需修改) ---
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

// --- 5. 翻译单个页面的核心函数 (此函数无需修改) ---
async function processPage(sourceUrl, fullDictionary, sortedKeys, imageReplacementMap, lastEditInfoState, forceTranslateList = []) {
    let pageName = '';
    try {
        pageName = getPageNameFromWikiLink(sourceUrl) || path.basename(new URL(sourceUrl).pathname);
        if (!pageName || pageName === '/') pageName = START_PAGE;
    } catch (e) {
        console.error(`无效的源 URL: ${sourceUrl}`);
        return null;
    }
    const OUTPUT_FILE = path.join(OUTPUT_DIR, `${pageName}.html`);

    console.log(`[${pageName}] 开始抓取页面: ${sourceUrl}`);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    let htmlContent;
    try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#mw-content-text', { timeout: 30000 });
        htmlContent = await page.content();
    } catch (error) {
        console.error(`[${pageName}] 抓取或等待页面内容时发生错误: ${error.message}`);
        await browser.close();
        return null;
    } finally {
        await browser.close();
    }
    console.log(`[${pageName}] 页面抓取成功。`);

    const $ = cheerio.load(htmlContent);

    const isForced = forceTranslateList.includes(pageName);
    const $smallTag = $('small'); 
    const currentEditInfo = $smallTag.length > 0 ? $smallTag.text().trim() : null;

    if (isForced) {
        console.log(`[${pageName}] 强制翻译模式: 将忽略编辑信息检查并继续处理。`);
    } else if (currentEditInfo && lastEditInfoState[pageName] === currentEditInfo) {
        console.log(`[${pageName}] 页面内容未更改。跳过翻译，但仍会解析链接。`);
        return { translationResult: null, rawHtml: htmlContent };
    } else if (!currentEditInfo) {
        console.warn(`[${pageName}] ⚠️ 未能找到最后编辑信息。将继续处理。`);
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
        const factScript = `<script>document.addEventListener('DOMContentLoaded', function() { const factsUrl = '/facts.json'; const placeholder = document.getElementById('dynamic-fact-placeholder'); if (placeholder) { fetch(factsUrl).then(response => { if (!response.ok) { throw new Error('网络响应错误，状态码: ' + response.status); } return response.json(); }).then(facts => { if (facts && Array.isArray(facts) && facts.length > 0) { const randomIndex = Math.floor(Math.random() * facts.length); const randomFact = facts[randomIndex].cn; placeholder.innerHTML = randomFact; } else { placeholder.innerHTML = '暂时没有可显示的事实。'; } }).catch(error => { console.error('加载或显示事实时出错:', error); placeholder.innerHTML = '加载事实失败，请稍后再试。'; }); } });</script>`;
        bodyEndScripts.push(factScript);
    }
    const originalTitle = $('title').text() || pageName;
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
                console.warn(`[${pageName}] 转换内部资源链接时出错: ${originalHref}`);
            }
        }
    });

    $contentContainer.find('img').each(function() {
        const $el = $(this); let src = $el.attr('src'); if (src) { const absoluteSrc = src.startsWith('/') ? BASE_URL + src : src; if (imageReplacementMap.has(absoluteSrc)) { $el.attr('src', imageReplacementMap.get(absoluteSrc)); } else if (src.startsWith('/')) { $el.attr('src', absoluteSrc); } }
        const srcset = $el.attr('srcset'); if (srcset) { const newSrcset = srcset.split(',').map(s => { const parts = s.trim().split(/\s+/); let url = parts[0]; const descriptor = parts.length > 1 ? ` ${parts[1]}` : ''; const absoluteUrl = url.startsWith('/') ? BASE_URL + url : url; if (imageReplacementMap.has(absoluteUrl)) { return imageReplacementMap.get(absoluteUrl) + descriptor; } return (url.startsWith('/') ? absoluteUrl : url) + descriptor; }).join(', '); $el.attr('srcset', newSrcset); }
    });
    const textNodes = [];
    $contentContainer.find('*:not(script,style)').addBack().contents().each(function() { if (this.type === 'text' && this.data.trim() && !$(this).parent().is('span.hotkey')) { textNodes.push(this); } });
    const textPromises = textNodes.map(node => { const preReplaced = replaceTermsDirectly(node.data, fullDictionary, sortedKeys); return translateTextWithEnglishCheck(preReplaced); });
    const translatedTexts = await Promise.all(textPromises);
    textNodes.forEach((node, index) => { if (translatedTexts[index]) { node.data = translatedTexts[index].trim(); } });
    const elementsWithAttributes = $contentContainer.find('[title], [alt]');
    for (let i = 0; i < elementsWithAttributes.length; i++) {
        const $element = $(elementsWithAttributes[i]);
        for (const attr of ['title', 'alt']) { const originalValue = $element.attr(attr); if (originalValue) { const preReplaced = replaceTermsDirectly(originalValue, fullDictionary, sortedKeys); const translatedValue = await translateTextWithEnglishCheck(preReplaced); $element.attr(attr, translatedValue); } }
    }
    let finalHtmlContent = $contentContainer.html();
    finalHtmlContent = finalHtmlContent.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3').replace(/rgb\(70, 223, 17\)/g, '#76FF33');
    
    let homeButtonHtml = '';
    if (pageName !== START_PAGE) { homeButtonHtml = `<a href="./${START_PAGE}" style="display: inline-block; margin: 0 0 25px 0; padding: 12px 24px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 8px; font-family: 'Rubik', 'M PLUS 1p', sans-serif; transition: background-color 0.3s ease, transform 0.2s ease; box-shadow: 0 4px 8px rgba(0,0,0,0.2);" onmouseover="this.style.backgroundColor='#a8c0e0'; this.style.transform='scale(1.03)';" onmouseout="this.style.backgroundColor='#BFD5FF'; this.style.transform='scale(1)';">返回主页</a>`; }
    
    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    ');
    const bodyClasses = $('body').attr('class') || '';
    const finalHtml = `<!DOCTYPE html><html lang="zh-CN" dir="ltr"><head><meta charset="UTF-8"><title>${translatedTitle}</title>${headContent}<style>@import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');body{font-family:'Rubik','M PLUS 1p',sans-serif;background-color:#001926 !important;}#mw-main-container{max-width:1200px;margin:20px auto;background-color:#001926;padding:20px;}</style></head><body class="${bodyClasses}"><div id="mw-main-container">${homeButtonHtml}<div class="main-content"><div class="mw-body ve-init-mw-desktopArticleTarget-targetContainer" id="content" role="main"><a id="top"></a><div class="mw-body-content" id="bodyContent"><div id="siteNotice"></div><div id="mw-content-text" class="mw-content-ltr mw-parser-output" lang="zh-CN" dir="ltr">${finalHtmlContent}</div></div></div></div></div>${bodyEndScripts.join('\n    ')}</body></html>`;
    
    fs.writeFileSync(OUTPUT_FILE, finalHtml, 'utf-8');
    console.log(`✅ [${pageName}] 翻译完成！文件已保存到: ${OUTPUT_FILE}`);

    return { translationResult: { pageName: pageName, newEditInfo: currentEditInfo }, rawHtml: htmlContent };
}


// --- 6. 主运行函数 (此函数无需修改) ---
async function run() {
    console.log("--- 翻译任务开始 (爬虫模式) ---");

    try {
        const imageReplacementMap = getPreparedImageDictionary();
        const { fullDictionary, sortedKeys } = await getPreparedDictionary();
        
        let lastEditInfo = {};
        if (fs.existsSync(EDIT_INFO_FILE)) {
            try { lastEditInfo = JSON.parse(fs.readFileSync(EDIT_INFO_FILE, 'utf-8')); console.log(`已成功加载上次的编辑信息记录。`); } catch (e) { console.error(`❌ 读取或解析 ${EDIT_INFO_FILE} 时出错，将作为首次运行处理。`); }
        }

        if (!fs.existsSync(OUTPUT_DIR)) { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); }

        const pagesToProcess = new Set([START_PAGE]);
        const processedPages = new Set();
        const newEditInfo = { ...lastEditInfo };
        let hasUpdates = false;

        console.log(`\n==================================================`);
        console.log(`爬虫启动，起始页面: ${START_PAGE}`);
        console.log(`并行处理上限: ${CONCURRENCY_LIMIT}`);
        console.log(`==================================================\n`);

        while (pagesToProcess.size > 0) {
            const batch = Array.from(pagesToProcess).slice(0, CONCURRENCY_LIMIT);
            
            const promises = batch.map(async (pageName) => {
                pagesToProcess.delete(pageName);
                if (processedPages.has(pageName)) {
                    return; 
                }
                processedPages.add(pageName);

                const fullUrl = `${BASE_URL}/${encodeURIComponent(pageName)}`;
                
                try {
                    const processOutput = await processPage(fullUrl, fullDictionary, sortedKeys, imageReplacementMap, lastEditInfo);
                    if (!processOutput) { return; }

                    if (processOutput.translationResult) {
                        const { pageName: pName, newEditInfo: editInfo } = processOutput.translationResult;
                        if (pName && editInfo && newEditInfo[pName] !== editInfo) {
                            newEditInfo[pName] = editInfo;
                            hasUpdates = true;
                        }
                    }

                    const $ = cheerio.load(processOutput.rawHtml);
                    const newLinks = findInternalLinks($);
                    
                    if (newLinks.length > 0) {
                        console.log(`[${pageName}] 在页面上发现 ${newLinks.length} 个新链接: [${newLinks.join(', ')}]`);
                        newLinks.forEach(link => {
                            if (!processedPages.has(link) && !pagesToProcess.has(link)) {
                                pagesToProcess.add(link);
                            }
                        });
                    } else {
                        console.log(`[${pageName}] 未在该页面上发现可处理的新链接。`);
                    }

                } catch (error) {
                    console.error(`❌ 处理页面 ${pageName} 过程中发生严重错误:`, error.message);
                }
            });

            await Promise.all(promises);

            console.log(`\n--- 本批次处理完成 ---`);
            console.log(`已处理页面总数: ${processedPages.size}`);
            console.log(`待处理队列剩余: ${pagesToProcess.size}`);
            console.log(`----------------------\n`);
        }

        if (hasUpdates) {
            fs.writeFileSync(EDIT_INFO_FILE, JSON.stringify(newEditInfo, null, 2), 'utf-8');
            console.log(`\n✅ 最后编辑信息已更新到 ${EDIT_INFO_FILE}`);
        } else {
            console.log("\n所有已处理页面的最后编辑信息均无变化。");
        }

        console.log("\n--- 所有可达页面处理完毕，任务结束 ---");

    } catch (error) {
        console.error("❌ 任务初始化或执行过程中发生致命错误:", error.message, error.stack);
        process.exit(1);
    }
}

// 开始执行脚本
run();
