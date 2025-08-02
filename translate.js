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

// --- 【新增】下载图片的辅助函数 ---
// 功能：下载单个图片到指定的本地路径，并自动创建目录。
// downloadedImageUrls: 一个 Set 对象，用于跟踪已下载的图片，避免重复下载。
async function downloadImage(imageUrl, outputDir, downloadedImageUrls) {
    // 检查是否已经下载过，避免重复工作
    if (downloadedImageUrls.has(imageUrl)) {
        return;
    }

    let urlObj;
    try {
        urlObj = new URL(imageUrl);
    } catch (e) {
        console.error(`❌ 无效的图片 URL: ${imageUrl}`);
        return;
    }

    // 从 URL 中提取相对路径 (例如: /images/thumb/a/ab/Some_Image.png/120px-Some_Image.png)
    const relativePath = decodeURIComponent(urlObj.pathname);
    // 构建完整的本地保存路径
    const localPath = path.join(outputDir, relativePath);
    // 获取本地路径的目录部分，用于检查和创建文件夹
    const dirName = path.dirname(localPath);

    // 如果目标文件夹不存在，则递归创建它
    if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
    }

    // 如果文件已存在，则跳过下载 (可能在之前的运行中已下载)
    if (fs.existsSync(localPath)) {
        // console.log(`[图片] 文件已存在，跳过: ${relativePath}`);
        downloadedImageUrls.add(imageUrl); // 标记为已处理
        return;
    }

    try {
        console.log(`[图片] 正在下载: ${imageUrl}`);
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`网络请求失败: ${response.status} ${response.statusText}`);
        }
        // 将响应体转为 ArrayBuffer，这是处理二进制文件的标准方式
        const imageBuffer = await response.arrayBuffer();
        // 写入文件
        fs.writeFileSync(localPath, Buffer.from(imageBuffer));
        // console.log(`[图片] ✅ 下载成功: ${localPath}`);
        downloadedImageUrls.add(imageUrl); // 下载成功后，添加到 Set 中
    } catch (error) {
        console.error(`❌ 下载图片 ${imageUrl} 失败:`, error.message);
    }
}


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

// --- 4. 带英文检测的翻译函数 (已修复) ---
async function translateTextWithEnglishCheck(textToTranslate) {
    if (!textToTranslate || !textToTranslate.trim()) { return ""; }
    if (!containsEnglish(textToTranslate)) { return textToTranslate; }

    try {
        const res = await bingTranslate(textToTranslate, 'en', 'zh-Hans', false);
        return res?.translation || textToTranslate;
    } catch (bingError) {
        console.warn(`⚠️ 必应翻译失败 (回退到谷歌): ${bingError.message.substring(0, 100)}`);
        try {
            const res = await googleTranslate(textToTranslate, { from: 'en', to: 'zh-CN' });
            return res?.text || textToTranslate;
        } catch (googleError) {
            console.error(`❌ 谷歌翻译也失败了。将返回原始文本。`);
            return textToTranslate;
        }
    }
}


// --- 辅助函数：从链接中提取可处理的页面名称 ---
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

    if (pathname.endsWith('/index.php')) {
        return null;
    }
    
    let pageName = pathname.substring(1);

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

// --- 5. 翻译单个页面的核心函数 ---
// --- 【修改】函数签名增加了 downloadedImageUrls 参数 ---
async function processPage(sourceUrl, fullDictionary, sortedKeys, imageReplacementMap, lastEditInfoState, downloadedImageUrls, forceTranslateList = []) {
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
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForSelector('#mw-content-text', { timeout: 0 });
        
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

    // --- 【修改】图片处理逻辑 ---
    const imageDownloadPromises = []; // 存储所有图片下载的 Promise

    $contentContainer.find('img').each(function() {
        const $el = $(this);

        // 统一处理 src 和 srcset 中的 URL
        const processUrl = (url) => {
            if (!url) return url;
            
            // 1. 构建绝对 URL
            const absoluteUrl = new URL(url, BASE_URL).href;

            // 2. 检查是否在图片替换词典中
            if (imageReplacementMap.has(absoluteUrl)) {
                return imageReplacementMap.get(absoluteUrl);
            }

            // 3. 检查是否是本站的图片，需要下载
            if (absoluteUrl.startsWith(BASE_URL)) {
                // 将下载任务添加到 Promise 数组中
                imageDownloadPromises.push(downloadImage(absoluteUrl, OUTPUT_DIR, downloadedImageUrls));
                
                // 返回相对于 output 目录的相对路径
                const urlObj = new URL(absoluteUrl);
                // 移除开头的斜杠，得到 'images/...' 这样的相对路径
                return decodeURIComponent(urlObj.pathname).substring(1); 
            }

            // 4. 如果是外部图片，则保持原样（已经是绝对 URL）
            return absoluteUrl;
        };

        // 处理 src 属性
        const src = $el.attr('src');
        if (src) {
            $el.attr('src', processUrl(src));
        }

        // 处理 srcset 属性
        const srcset = $el.attr('srcset');
        if (srcset) {
            const newSrcset = srcset
                .split(',')
                .map(part => {
                    const item = part.trim().split(/\s+/);
                    const url = item[0];
                    const descriptor = item.length > 1 ? ` ${item[1]}` : '';
                    return processUrl(url) + descriptor;
                })
                .join(', ');
            $el.attr('srcset', newSrcset);
        }
    });

    // 等待本页面所有图片的下载任务完成
    if (imageDownloadPromises.length > 0) {
        console.log(`[${pageName}] 正在处理 ${imageDownloadPromises.length} 个图片下载任务...`);
        await Promise.all(imageDownloadPromises);
        console.log(`[${pageName}] 图片下载任务处理完毕。`);
    }
    // --- 图片处理逻辑修改结束 ---


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


// --- 6. 主运行函数 ---
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
        
        // --- 【新增】创建一个 Set 来跟踪整个运行过程中已下载的图片 ---
        const downloadedImageUrls = new Set();

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
                    // --- 【修改】将 downloadedImageUrls 传递给 processPage 函数 ---
                    const processOutput = await processPage(fullUrl, fullDictionary, sortedKeys, imageReplacementMap, lastEditInfo, downloadedImageUrls);
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
