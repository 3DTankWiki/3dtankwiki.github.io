// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { translate: googleTranslate } = require('@vitalets/google-translate-api');
const { translate: bingTranslate } = require('bing-translate-api');
const pluralize = require('pluralize');
const fs = require('fs');
const path = require('path');

// --- 【配置常量】 ---
const BASE_URL ='https://en.tankiwiki.com';
const DICTIONARY_URL = 'https://testanki1.github.io/translations.js'; // 示例词典 URL
const OUTPUT_DIR = './output'; // 输出文件夹

// --- 【页面列表】 ---
// 您可以在这里添加或删除需要翻译的页面名称
const PAGES_TO_TRANSLATE = [
    'Tanki_Online_Wiki',
    'Turrets',
    'Hulls',
    'Drones',
    'Protection_Modules',
    'Help',
];

// --- 1. 准备词典 ---
async function getPreparedDictionary() {
    console.log(`正在从 URL 获取词典: ${DICTIONARY_URL}`);
    let originalDict;
    try {
        const response = await fetch(DICTIONARY_URL);
        if (!response.ok) { throw new Error(`网络请求失败: ${response.status}`); }
        const scriptContent = await response.text();
        // 使用一个安全的 Function 构造函数来从脚本内容中提取对象
        originalDict = new Function(`${scriptContent}; return replacementDict;`)();
        console.log("在线词典加载成功。原始大小:", Object.keys(originalDict).length);
    } catch (error) {
        console.error("加载或解析在线词典时出错。将使用空词典。", error);
        return { fullDictionary: new Map(), sortedKeys: [] }; // 确保在失败时返回有效结构
    }

    const tempDict = { ...originalDict };
    // 添加单词的复数形式到词典中（如果不存在）
    for (const key in originalDict) {
        if (Object.hasOwnProperty.call(originalDict, key)) {
            const pluralKey = pluralize(key);
            if (pluralKey !== key && !tempDict.hasOwnProperty(pluralKey)) {
                tempDict[pluralKey] = originalDict[key];
            }
        }
    }
    
    const fullDictionary = new Map(Object.entries(tempDict));
    // 按键的长度降序排序，以优先匹配更长的术语
    const sortedKeys = Object.keys(tempDict).sort((a, b) => b.length - a.length);
    console.log(`词典准备完毕。总词条数 (含复数): ${fullDictionary.size}，已按长度排序。`);
    return { fullDictionary, sortedKeys };
}

// --- 2. 直接替换函数 ---
function replaceTermsDirectly(text, fullDictionary, sortedKeys) {
    if (!text) return "";
    let result = text;
    for (const key of sortedKeys) {
        // 使用 \b 来确保匹配整个单词，避免替换单词的一部分
        const regex = new RegExp(`\\b${key}\\b`, 'gi');
        if (regex.test(result)) {
            result = result.replace(regex, fullDictionary.get(key));
        }
    }
    return result;
}

// --- 3. 检测是否包含英文字母的函数 ---
function containsEnglish(text) {
    // 使用正则表达式匹配任何 a-z 或 A-Z 的字母
    return /[a-zA-Z]/.test(text);
}

// --- 4. 带英文检测的翻译函数 ---
async function translateTextWithEnglishCheck(textToTranslate) {
    if (!textToTranslate || !textToTranslate.trim()) {
        return ""; // 如果文本为空或只有空格，直接返回空字符串
    }

    // 如果文本不包含任何英文字母，说明它可能已经是纯中文或符号，直接返回
    if (!containsEnglish(textToTranslate)) {
        return textToTranslate;
    }

    // 优先尝试 Bing 翻译，失败后回退到 Google 翻译
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
            return textToTranslate; // 所有翻译都失败时，返回原始文本
        }
    }
}


// --- 5. 翻译单个页面的核心函数 (最终版：保留 CSS 和 JS) ---
async function translatePage(sourceUrl, fullDictionary, sortedKeys) {
    let filename = '';
    try {
        const url = new URL(sourceUrl);
        filename = path.basename(url.pathname);
        if (!filename || filename === '/') filename = 'index'; // 默认文件名
    } catch (e) {
        console.error(`无效的源 URL: ${sourceUrl}`);
        return;
    }
    const OUTPUT_FILE = path.join(OUTPUT_DIR, `${filename}.html`);

    console.log(`[${filename}] 开始抓取页面: ${sourceUrl}`);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(sourceUrl, { waitUntil: 'networkidle0' });
    const htmlContent = await page.content();
    await browser.close();
    console.log(`[${filename}] 页面抓取成功。`);

    const $ = cheerio.load(htmlContent);

    // --- 资源处理：捕获并修正所有 CSS 和 JS 的路径 ---
    const headElements = [];
    $('head').children('link, style, script, meta, title').each(function() {
        const $el = $(this);
        // 修正 link 标签的 href
        if ($el.is('link')) {
            const href = $el.attr('href');
            if (href && href.startsWith('/')) {
                $el.attr('href', BASE_URL + href);
            }
        }
        // 修正 script 标签的 src
        if ($el.is('script')) {
            const src = $el.attr('src');
            if (src && src.startsWith('/')) {
                $el.attr('src', BASE_URL + src);
            }
        }
        headElements.push($.html(this));
    });

    const bodyEndScripts = [];
    $('body > script').each(function() {
        const $el = $(this);
        const src = $el.attr('src');
        if (src && src.startsWith('/')) {
            $el.attr('src', BASE_URL + src);
        }
        bodyEndScripts.push($.html(this));
    });

    console.log(`[${filename}] 资源捕获完成: ${headElements.length} 个头部元素, ${bodyEndScripts.length} 个 Body 脚本。`);


    // --- 内容提取与翻译 ---
    const $contentContainer = $('<div id="wiki-content-wrapper"></div>');
    $('#firstHeading').clone().appendTo($contentContainer);
    $('#mw-content-text .mw-parser-output').children().each(function() {
        $contentContainer.append($(this).clone());
    });
    
    // 标题翻译
    const originalTitle = $('title').text() || filename;
    const preReplacedTitle = replaceTermsDirectly(originalTitle, fullDictionary, sortedKeys);
    let translatedTitle = await translateTextWithEnglishCheck(preReplacedTitle);
    translatedTitle = translatedTitle.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3');
    console.log(`[${filename}] [标题] 翻译完成: "${translatedTitle}"`);

    // 链接和图片路径处理
    $contentContainer.find('img, a').each(function() {
        const $el = $(this);
        const href = $el.attr('href');
        if (href?.startsWith('/')) { try { $el.attr('href', new URL(href, BASE_URL).pathname); } catch(e) { console.warn(`[${filename}] 无效的 href: ${href}`); } }
        const src = $el.attr('src');
        if (src?.startsWith('/')) { $el.attr('src', BASE_URL + src); }
        const srcset = $el.attr('srcset');
        if (srcset) {
            const newSrcset = srcset.split(',').map(s => { const t = s.trim().split(/\s+/); if (t[0].startsWith('/')) { t[0] = BASE_URL + t[0]; } return t.join(' '); }).join(', ');
            $el.attr('srcset', newSrcset);
        }
    });

    // 可见文本翻译
    const textNodes = [];
    $contentContainer.find('*:not(script,style)').addBack().contents().each(function() { if (this.type === 'text' && this.data.trim()) { textNodes.push(this); } });
    console.log(`[${filename}] 准备处理 ${textNodes.length} 个可见文本片段...`);
    const textPromises = textNodes.map(node => {
        const preReplaced = replaceTermsDirectly(node.data, fullDictionary, sortedKeys);
        return translateTextWithEnglishCheck(preReplaced);
    });
    const translatedTexts = await Promise.all(textPromises);
    textNodes.forEach((node, index) => { if (translatedTexts[index]) { node.data = translatedTexts[index].trim(); } });
    console.log(`[${filename}] 可见文本处理完成。`);

    // 属性文本翻译
    const elementsWithAttributes = $contentContainer.find('[title], [alt]');
    console.log(`[${filename}] 准备处理 ${elementsWithAttributes.length} 个元素的属性...`);
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
    console.log(`[${filename}] 属性处理完成。`);


    // --- HTML 整合与构建 ---
    let finalHtmlContent = $contentContainer.html();
    
    // 中文间空格清理
    finalHtmlContent = finalHtmlContent.replace(/([\u4e00-\u9fa5])([\s_]+)([\u4e00-\u9fa5])/g, '$1$3');
    
    // 【代码修改】根据请求，将所有 rgb(70, 223, 17) 颜色替换为 #76FF33
    finalHtmlContent = finalHtmlContent.replace(/rgb\(70, 223, 17\)/g, '#76FF33');

    // 创建“返回主页”按钮 (仅在非主页上)
    let homeButtonHtml = '';
    const homePageFilename = 'Tanki_Online_Wiki';
    if (filename !== homePageFilename) {
        homeButtonHtml = `
        <a href="./${homePageFilename}.html" style="
            display: inline-block;
            margin: 0 0 25px 0;
            padding: 12px 24px;
            background-color: #BFD5FF;
            color: #001926;
            text-decoration: none;
            font-weight: bold;
            border-radius: 8px;
            font-family: 'Rubik', 'M PLUS 1p', sans-serif;
            transition: background-color 0.3s ease, transform 0.2s ease;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        " onmouseover="this.style.backgroundColor='#a8c0e0'; this.style.transform='scale(1.03)';" onmouseout="this.style.backgroundColor='#BFD5FF'; this.style.transform='scale(1)';">
            返回主页
        </a>`;
    }


    // 从捕获的 head 元素中移除旧标题，稍后用新标题
    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    ');
    const bodyClasses = $('body').attr('class') || '';

    // 【HTML 模板】
    const finalHtml = `<!DOCTYPE html>
<html lang="zh-CN" dir="ltr">
<head>
    <meta charset="UTF-8">
    <title>${translatedTitle}</title>
    ${headContent}
    <style>
        /* --- 字体设置 --- */
        @import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');
        
        /* 强制覆盖样式 */
        body {
            font-family: 'Rubik', 'M PLUS 1p', sans-serif; /* 设置第一和第二字体 */
            background-color: #001926 !important;
        }
        #mw-main-container {
            max-width: 1200px;
            margin: 20px auto;
            background-color: #001926;
            padding: 20px; /* 增加内边距给按钮空间 */
        }
        /* 如果需要，可以添加更多自定义样式 */
    </style>
</head>
<body class="${bodyClasses}">
    <div id="mw-main-container">
        ${homeButtonHtml}
        <div class="main-content">
            <div class="mw-body ve-init-mw-desktopArticleTarget-targetContainer" id="content" role="main">
                <a id="top"></a>
                <div class="mw-body-content" id="bodyContent">
                    <div id="siteNotice"></div>
                    <div id="mw-content-text" class="mw-content-ltr mw-parser-output" lang="zh-CN" dir="ltr">
                        ${finalHtmlContent}
                    </div>
                </div>
            </div>
        </div>
    </div>
    ${bodyEndScripts.join('\n    ')}
</body>
</html>`;

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    fs.writeFileSync(OUTPUT_FILE, finalHtml, 'utf-8');
    console.log(`✅ [${filename}] 翻译完成！文件已保存到: ${OUTPUT_FILE}`);
}

// --- 6. 主运行函数 (并行处理) ---
async function run() {
    console.log("--- 翻译任务开始 ---");
    
    const { fullDictionary, sortedKeys } = await getPreparedDictionary();
    if (fullDictionary.size === 0) {
        console.log("警告：词典为空，所有翻译将仅依赖翻译API。");
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    console.log(`\n==================================================`);
    console.log(`即将并行处理 ${PAGES_TO_TRANSLATE.length} 个页面...`);
    console.log(`==================================================`);

    // 创建所有页面翻译任务的 Promise 数组
    const translationPromises = PAGES_TO_TRANSLATE.map(pageName => {
        const fullUrl = `${BASE_URL}/${pageName}`;
        // 调用 translatePage 但不等待它完成，而是返回 Promise
        return translatePage(fullUrl, fullDictionary, sortedKeys)
            .catch(error => {
                // 为每个页面单独捕获错误，防止一个页面的失败导致整个 Promise.all 失败
                console.error(`❌ 处理页面 ${pageName} 时发生严重错误:`, error.message, error.stack);
            });
    });

    // 等待所有任务完成
    await Promise.all(translationPromises);

    console.log("\n--- 所有页面处理完毕 ---");
}

// 开始执行脚本
run();