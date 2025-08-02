// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio =require('cheerio');
const { translate: googleTranslate } = require('@vitalets/google-translate-api');
const { translate: bingTranslate } = require('bing-translate-api');
const pluralize = require('pluralize');
const fs = require('fs');
const path = require('path');

// --- 【配置常量】 ---
const BASE_URL ='https://en.tankiwiki.com';
const DICTIONARY_URL = 'https://testanki1.github.io/translations.js'; 
const IMAGE_DICT_FILE = 'image_replacements.js'; 
const OUTPUT_DIR = './output';
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');
// --- 【修改】页面列表从本地文件名加载 ---
const PAGE_LISTS_FILE = 'page_lists.js'; 


// --- 【修改】从本地文件获取页面列表 ---
function getLocalPageLists() {
    const filePath = path.resolve(__dirname, PAGE_LISTS_FILE);
    console.log(`正在从本地文件加载页面列表: ${filePath}`);

    if (!fs.existsSync(filePath)) {
        console.error(`❌ 页面列表文件未找到: ${PAGE_LISTS_FILE}`);
        throw new Error(`无法获取页面列表，任务中止。`);
    }

    try {
        const scriptContent = fs.readFileSync(filePath, 'utf-8');
        const lists = new Function(`${scriptContent}; return pageLists;`)();
        
        // 验证获取的数据结构是否正确
        if (!lists || !Array.isArray(lists.regular) || !Array.isArray(lists.forced)) {
            throw new Error('页面列表文件数据格式错误或缺少 "regular" / "forced" 键。');
        }

        console.log(`本地页面列表加载成功。常规页面: ${lists.regular.length}, 强制页面: ${lists.forced.length}。`);
        return lists; // 返回包含 { regular: [], forced: [] } 的对象
    } catch (error) {
        console.error(`❌ 加载或解析本地页面列表文件 ${PAGE_LISTS_FILE} 时出错:`, error.message);
        throw new Error(`无法获取页面列表，任务中止。`);
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

// --- 5. 翻译单个页面的核心函数 ---
async function translatePage(sourceUrl, fullDictionary, sortedKeys, imageReplacementMap, lastEditInfoState, forceTranslateList) {
    let pageName = '';
    try {
        const url = new URL(sourceUrl);
        pageName = path.basename(url.pathname);
        if (!pageName || pageName === '/') pageName = 'index';
    } catch (e) {
        console.error(`无效的源 URL: ${sourceUrl}`);
        return null;
    }
    const OUTPUT_FILE = path.join(OUTPUT_DIR, `${pageName}.html`);

    console.log(`[${pageName}] 开始抓取页面: ${sourceUrl}`);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(sourceUrl, { waitUntil: 'networkidle0' });
    const htmlContent = await page.content();
    await browser.close();
    console.log(`[${pageName}] 页面抓取成功。`);

    const $ = cheerio.load(htmlContent);

    // --- 检查页面是否需要更新（包含强制翻译逻辑） ---
    const isForced = forceTranslateList.includes(pageName);
    
    if (isForced) {
        console.log(`[${pageName}] 强制翻译模式: 将忽略编辑信息检查并继续处理。`);
    } else {
        const $smallTag = $('small'); 
        const currentEditInfo = $smallTag.length > 0 ? $smallTag.text().trim() : null;
        
        if (currentEditInfo) {
            const previousEditInfo = lastEditInfoState[pageName];
            if (previousEditInfo && previousEditInfo === currentEditInfo) {
                console.log(`[${pageName}] 页面内容未更改 (最后编辑信息相同)。跳过此页面。`);
                return null; 
            }
        } else {
            console.warn(`[${pageName}] ⚠️ 未能找到 <small> 标签中的最后编辑信息。将继续处理。`);
        }
    }
    
    const currentEditInfoForUpdate = $('small').text().trim() || null;

    // --- 资源处理 ---
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
        headElements.push($.html(this));
    });
    const bodyEndScripts = [];
    $('body > script').each(function() {
        const $el = $(this);
        const src = $el.attr('src');
        if (src && src.startsWith('/')) { $el.attr('src', BASE_URL + src); }
        bodyEndScripts.push($.html(this));
    });
    console.log(`[${pageName}] 资源捕获完成: ${headElements.length} 个头部元素, ${bodyEndScripts.length} 个 Body 脚本。`);
    
    // --- 内容提取与翻译 ---
    const $contentContainer = $('<div id="wiki-content-wrapper"></div>');
    $('#firstHeading').clone().appendTo($contentContainer);
    $('#mw-content-text .mw-parser-output').children().each(function() {
        $contentContainer.append($(this).clone());
    });
    
    // 处理“你知道吗”板块，注入客户端脚本
    const $factBoxContent = $contentContainer.find('.random-text-box > div:last-child');
    if ($factBoxContent.length > 0) {
        $factBoxContent.html('<p id="dynamic-fact-placeholder" style="margin:0;">正在加载有趣的事实...</p>');
        console.log(`[${pageName}] 找到“你知道吗”板块并设置占位符。`);
        const factScript = `
<script>
    document.addEventListener('DOMContentLoaded', function() {
        const factsUrl = '/facts.json'; 
        const placeholder = document.getElementById('dynamic-fact-placeholder');
        if (placeholder) {
            fetch(factsUrl)
                .then(response => {
                    if (!response.ok) { throw new Error('网络响应错误，状态码: ' + response.status); }
                    return response.json();
                })
                .then(facts => {
                    if (facts && Array.isArray(facts) && facts.length > 0) {
                        const randomIndex = Math.floor(Math.random() * facts.length);
                        const randomFact = facts[randomIndex].cn;
                        placeholder.innerHTML = randomFact;
                    } else {
                        placeholder.innerHTML = '暂时没有可显示的事实。';
                    }
                })
                .catch(error => {
                    console.error('加载或显示事实时出错:', error);
                    placeholder.innerHTML = '加载事实失败，请稍后再试。';
                });
        }
    });
</script>`;
        bodyEndScripts.push(factScript);
        console.log(`[${pageName}] 已准备用于客户端加载事实的脚本。`);
    }

    const originalTitle = $('title').text() || pageName;
    
    const preReplacedTitle = replaceTermsDirectly(originalTitle, fullDictionary, sortedKeys);
    let translatedTitle = await translateTextWithEnglishCheck(preReplacedTitle);
    translatedTitle = translatedTitle.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3');
    console.log(`[${pageName}] [标题] 翻译完成: "${translatedTitle}"`);

    $contentContainer.find('a').each(function() {
        const href = $(this).attr('href');
        if (href?.startsWith('/')) { 
            try { 
                $(this).attr('href', new URL(href, BASE_URL).pathname); 
            } catch(e) { 
                console.warn(`[${pageName}] 无效的 href: ${href}`); 
            } 
        }
    });

    $contentContainer.find('img').each(function() {
        const $el = $(this);
        let src = $el.attr('src');
        if (src) {
            const absoluteSrc = src.startsWith('/') ? BASE_URL + src : src;
            if (imageReplacementMap.has(absoluteSrc)) {
                const newSrc = imageReplacementMap.get(absoluteSrc);
                $el.attr('src', newSrc);
                console.log(`[${pageName}] [图片替换] src: ${absoluteSrc} -> ${newSrc}`);
            } else if (src.startsWith('/')) {
                $el.attr('src', absoluteSrc);
            }
        }
        const srcset = $el.attr('srcset');
        if (srcset) {
            const newSrcset = srcset.split(',').map(s => {
                const parts = s.trim().split(/\s+/);
                let url = parts[0];
                const descriptor = parts.length > 1 ? ` ${parts[1]}` : '';
                const absoluteUrl = url.startsWith('/') ? BASE_URL + url : url;
                if (imageReplacementMap.has(absoluteUrl)) {
                    const newUrl = imageReplacementMap.get(absoluteUrl);
                    console.log(`[${pageName}] [图片替换] srcset: ${absoluteUrl} -> ${newUrl}`);
                    return newUrl + descriptor;
                }
                return (url.startsWith('/') ? absoluteUrl : url) + descriptor;
            }).join(', ');
            $el.attr('srcset', newSrcset);
        }
    });

    const textNodes = [];
    $contentContainer.find('*:not(script,style)').addBack().contents().each(function() { 
        if (this.type === 'text' && this.data.trim()) {
            if ($(this).parent().is('span.hotkey')) {
                // 不做任何事，直接跳过
            } else {
                textNodes.push(this);
            }
        } 
    });
    console.log(`[${pageName}] 准备处理 ${textNodes.length} 个可见文本片段...`);

    const textPromises = textNodes.map(node => {
        const preReplaced = replaceTermsDirectly(node.data, fullDictionary, sortedKeys);
        return translateTextWithEnglishCheck(preReplaced);
    });
    const translatedTexts = await Promise.all(textPromises);

    textNodes.forEach((node, index) => { 
        if (translatedTexts[index]) { 
            node.data = translatedTexts[index].trim(); 
        } 
    });
    console.log(`[${pageName}] 可见文本处理完成。`);

    const elementsWithAttributes = $contentContainer.find('[title], [alt]');
    console.log(`[${pageName}] 准备处理 ${elementsWithAttributes.length} 个元素的属性...`);
    for (let i = 0; i < elementsWithAttributes.length; i++) {
        const element = elementsWithAttributes[i];
        const $element = $(element);
        for (const attr of ['title', 'alt']) {
            const originalValue = $element.attr(attr);
            if (originalValue) {
                const preReplaced = replaceTermsDirectly(originalValue, fullDictionary, sortedKeys);
                const translatedValue = await translateTextWithEnglishCheck(preReplaced);
                $element.attr(attr, translatedValue);
            }
        }
    }
    console.log(`[${pageName}] 属性处理完成。`);

    // --- HTML 整合与构建 ---
    let finalHtmlContent = $contentContainer.html();
    finalHtmlContent = finalHtmlContent.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3');
    finalHtmlContent = finalHtmlContent.replace(/rgb\(70, 223, 17\)/g, '#76FF33');

    let homeButtonHtml = '';
    const homePageFilename = 'Tanki_Online_Wiki';
    if (pageName !== homePageFilename) {
        homeButtonHtml = `<a href="./${homePageFilename}.html" style="display: inline-block; margin: 0 0 25px 0; padding: 12px 24px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 8px; font-family: 'Rubik', 'M PLUS 1p', sans-serif; transition: background-color 0.3s ease, transform 0.2s ease; box-shadow: 0 4px 8px rgba(0,0,0,0.2);" onmouseover="this.style.backgroundColor='#a8c0e0'; this.style.transform='scale(1.03)';" onmouseout="this.style.backgroundColor='#BFD5FF'; this.style.transform='scale(1)';">返回主页</a>`;
    }

    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    ');
    const bodyClasses = $('body').attr('class') || '';
    const finalHtml = `<!DOCTYPE html><html lang="zh-CN" dir="ltr"><head><meta charset="UTF-8"><title>${translatedTitle}</title>${headContent}<style>@import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');body{font-family:'Rubik','M PLUS 1p',sans-serif;background-color:#001926 !important;}#mw-main-container{max-width:1200px;margin:20px auto;background-color:#001926;padding:20px;}</style></head><body class="${bodyClasses}"><div id="mw-main-container">${homeButtonHtml}<div class="main-content"><div class="mw-body ve-init-mw-desktopArticleTarget-targetContainer" id="content" role="main"><a id="top"></a><div class="mw-body-content" id="bodyContent"><div id="siteNotice"></div><div id="mw-content-text" class="mw-content-ltr mw-parser-output" lang="zh-CN" dir="ltr">${finalHtmlContent}</div></div></div></div></div>${bodyEndScripts.join('\n    ')}</body></html>`;
    
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    fs.writeFileSync(OUTPUT_FILE, finalHtml, 'utf-8');
    console.log(`✅ [${pageName}] 翻译完成！文件已保存到: ${OUTPUT_FILE}`);

    return { pageName: pageName, newEditInfo: currentEditInfoForUpdate };
}

// --- 6. 主运行函数 (混合加载模式) ---
async function run() {
    console.log("--- 翻译任务开始 ---");

    try {
        // --- 1. 同步加载本地配置 ---
        const { regular: pagesToTranslate, forced: pagesToForceTranslate } = getLocalPageLists();
        const imageReplacementMap = getPreparedImageDictionary();
        
        // --- 2. 异步加载网络资源 ---
        const { fullDictionary, sortedKeys } = await getPreparedDictionary();
        
        // --- 3. 加载上次的编辑信息 ---
        let lastEditInfo = {};
        if (fs.existsSync(EDIT_INFO_FILE)) {
            try {
                lastEditInfo = JSON.parse(fs.readFileSync(EDIT_INFO_FILE, 'utf-8'));
                console.log(`已成功加载上次的编辑信息记录: ${EDIT_INFO_FILE}`);
            } catch (e) {
                console.error(`❌ 读取或解析 ${EDIT_INFO_FILE} 时出错，将作为首次运行处理。`, e.message);
                lastEditInfo = {};
            }
        } else {
            console.log("未找到编辑信息记录文件，将为所有页面创建新记录。");
        }

        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        const allPagesToProcess = [...new Set([...pagesToTranslate, ...pagesToForceTranslate])];
        
        console.log(`\n==================================================`);
        console.log(`常规页面: ${pagesToTranslate.length} 个`);
        console.log(`强制翻译页面: ${pagesToForceTranslate.length} 个`);
        console.log(`总计处理页面 (去重后): ${allPagesToProcess.length} 个`);
        console.log(`==================================================`);

        const translationPromises = allPagesToProcess.map(pageName => {
            const fullUrl = `${BASE_URL}/${pageName}`;
            return translatePage(fullUrl, fullDictionary, sortedKeys, imageReplacementMap, lastEditInfo, pagesToForceTranslate)
                .catch(error => {
                    console.error(`❌ 处理页面 ${pageName} 时发生严重错误:`, error.message, error.stack);
                    return null;
                });
        });

        const results = await Promise.all(translationPromises);
        
        let hasUpdates = false;
        const newEditInfo = { ...lastEditInfo }; 

        results.forEach(result => {
            if (result && result.pageName && result.newEditInfo) {
                if (newEditInfo[result.pageName] !== result.newEditInfo) {
                    newEditInfo[result.pageName] = result.newEditInfo;
                    hasUpdates = true;
                }
            }
        });

        if (hasUpdates) {
            fs.writeFileSync(EDIT_INFO_FILE, JSON.stringify(newEditInfo, null, 2), 'utf-8');
            console.log(`\n✅ 最后编辑信息已更新到 ${EDIT_INFO_FILE}`);
        } else {
            console.log("\n所有已处理页面的最后编辑信息均无变化。");
        }

        console.log("\n--- 所有页面处理完毕 ---");

    } catch (error) {
        // 捕获关键初始化步骤（如加载列表）中的错误
        console.error("❌ 任务初始化失败，无法继续:", error.message);
        process.exit(1); // 以错误码退出
    }
}

// 开始执行脚本
run();
