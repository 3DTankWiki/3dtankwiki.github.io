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

// === 排版格式化工具 ===
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

// 【将完整 HTML 和 翻译字典 一起投喂给 Gemini - 加入智能限速】
async function translateBatchWithGemini(tasksObj, dictStr) {
    const keys = Object.keys(tasksObj);
    if (keys.length === 0) return {};
    if (!process.env.GEMINI_API_KEY) {
        console.warn("⚠️ 未配置 GEMINI_API_KEY，跳过机翻。");
        return tasksObj;
    }

    const results = { ...tasksObj };
    
    // 【修改点 1】：不再按固定数量划分，而是按字符总长度划分，使每批次内容大小大致相同
    const TARGET_BATCH_CHARS = 3500; // // 适配 250K TPM 配额，最佳平衡输出限制与翻译质量
    const batches =[];
    let currentBatch = {};
    let currentCharCount = 0;

    for (const key of keys) {
        const itemLength = tasksObj[key].length;
        // 如果当前批次非空，且加上当前项后超出目标大小，则封存当前批次，开启下一个
        if (currentCharCount > 0 && (currentCharCount + itemLength) > TARGET_BATCH_CHARS) {
            batches.push(currentBatch);
            currentBatch = {};
            currentCharCount = 0;
        }
        currentBatch[key] = tasksObj[key];
        currentCharCount += itemLength;
    }
    // 将最后剩余的内容推入批次
    if (Object.keys(currentBatch).length > 0) {
        batches.push(currentBatch);
    }

    const dictPrompt = dictStr ? `
3. 【术语表要求】：请严格遵守以下提供的《翻译专有名词词库》。只要原文出现了词库中的英文，必须统一翻译为对应的中文：
--- 词库开始 ---
${dictStr}
--- 词库结束 ---
` : "3. 请根据《Tanki Online》（3D坦克）的游戏语境进行翻译，保证专业术语准确。";

    // 【修改点 2】：遍历动态计算好的批次
    for (let i = 0; i < batches.length; i++) {
        const batchObj = batches[i];
        const batchKeys = Object.keys(batchObj);

        const prompt = `你是一个专业的《Tanki Online》（3D坦克）游戏维基本地化翻译引擎。
请将以下 JSON 对象中的值（包含完整 HTML 标签的代码块）翻译为简体中文。

【极端重要的要求】：
1. JSON的键名（Key）绝对不可更改。只翻译键值（Value）。
2. 键值是包含完整 HTML 结构的字符串，你【必须原样保留】所有的 HTML 标签、类名、ID、内联样式和内部属性！绝对不能破坏 DOM 结构或遗漏任何标签！
${dictPrompt}
4. 【盘古之白排版规范 - 极其重要】：
   - 中文字符与中文字符之间【绝对不要加空格或 &nbsp; 实体】，即使它们被 HTML 标签隔开！比如输出必须是 "为了用<a href="...">红宝石</a>购买"，决不能出现空格！
   - 【英文/数字】与【中文汉字】的交界处，请加上一个半角空格！
   - 【严禁修改数值代码】：原文中的数值（如 187.5、205.5 等）必须【绝对原样保留】！绝对不要把数字中的小数点（.）改写成逗号（,），也绝对不要在数字中间随意加空格！
5. 除了词库中的术语，其余部分请结合上下文翻译得专业流畅。如果是普通句子末尾的英文标点，请翻译为中文标点；如果是数字内的标点或HTML代码，请原样保留。
6. 绝对不要使用 Markdown 代码块包裹输出！直接输出合法的、可被 JSON.parse() 解析的纯 JSON 格式！

待翻译 HTML 块的 JSON：
${JSON.stringify(batchObj, null, 2)}`;

        let batchResult = null;
        const maxRetries = 5;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await geminiModel.generateContent({
                    contents:[{ role: "user", parts:[{ text: prompt }] }],
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
                const errMsg = err.message || "";
                console.warn(`[Gemini 翻译尝试 ${attempt}/${maxRetries}] 失败: ${errMsg.substring(0, 150)}...`);
                
                if (attempt < maxRetries) {
                    let waitTime = 3000; 
                    
                    if (errMsg.includes('429') || errMsg.includes('Quota exceeded')) {
                        const retryMatch = errMsg.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
                        if (retryMatch && retryMatch[1]) {
                            const waitSeconds = parseFloat(retryMatch[1]);
                            waitTime = (waitSeconds + 2) * 1000; 
                            console.log(`⏳ 触发 API 配额限制 (TPM/RPM满载)！脚本将精准等待 ${Math.ceil(waitTime/1000)} 秒后复活...`);
                        } else {
                            waitTime = 64000; 
                            console.log(`⏳ 触发 API 配额限制！未检测到惩罚时长，强制默认休眠 64 秒...`);
                        }
                    }
                    
                    await new Promise(r => setTimeout(r, waitTime));
                }
            }
        }

        if (batchResult) {
            batchKeys.forEach(k => { if (batchResult[k]) results[k] = batchResult[k]; });
            console.log(`✅ 成功翻译批次:[${i + 1} / ${batches.length}] (包含 ${batchKeys.length} 个HTML块)`);
        } else {
            console.warn(`⚠️ 该批次在 ${maxRetries} 次尝试后仍彻底失败，回退为原始 HTML。`);
        }

        // 平滑流控：批次成功后也基础延时 5 秒，拉平 Token 消耗曲线
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
