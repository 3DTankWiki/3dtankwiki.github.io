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
const CONCURRENCY_LIMIT = 32; // 🚀 【核心】修改为 32，实现多标签页极速并发抓取
const TARGET_BATCH_CHARS = 100000; // 🚀 全局唯一合并阈值：坚守此红线
const DICTIONARY_URL = 'https://testanki1.github.io/translations.js'; 
const SOURCE_DICT_FILE = 'source_replacements.js'; 
const OUTPUT_DIR = './output';
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');

// 【新增】超时保护相关常量 (避免被 GitHub Actions 6小时强杀)
const MAX_EXECUTION_TIME_MINUTES = parseInt(process.env.MAX_EXECUTION_TIME || '345', 10); // 默认 5小时45分钟
const MAX_EXECUTION_TIME_MS = MAX_EXECUTION_TIME_MINUTES * 60 * 1000;
const SCRIPT_START_TIME = Date.now();

// 初始化 Gemini 客户端
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

const sanitizePageName = (name) => name.replaceAll(' ', '_');

async function getPagesForFeedMode(lastEditInfo) {
    console.log(`[更新模式] 正在从 ${RECENT_CHANGES_FEED_URL} 获取最近更新...`);
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: new Array('--no-sandbox', '--disable-setuid-sandbox') });
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
        for (const [title, newRevisionId] of pagesToConsider.entries()) {
            const blockedPrefixes = new Array('Special:', 'User:', 'MediaWiki:', 'Help:', 'Category:', 'File:', 'Template:');
            if (blockedPrefixes.some(p => title.startsWith(p))) continue;
            
            const currentRevisionId = lastEditInfo[title] || 0;
            if (newRevisionId > currentRevisionId) pagesToUpdate.push(title);
        }
        return pagesToUpdate;
    } catch (error) {
        console.error('❌[更新模式] 出错:', error.message);
        return new Array();
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

// 【底层兜底翻译：若单页大于阈值，依然会自动分片给 AI】
async function translateBatchWithGemini(tasksObj, dictStr) {
    const keys = Object.keys(tasksObj);
    if (keys.length === 0) return {};
    if (!process.env.GEMINI_API_KEY) {
        console.warn("⚠️ 未配置 GEMINI_API_KEY，跳过机翻。");
        return tasksObj;
    }

    const results = { ...tasksObj };
    
    const batches = new Array();
    let currentBatch = {};
    let currentCharCount = 0;

    for (const key of keys) {
        const itemLength = tasksObj[key].length;
        if (currentCharCount > 0 && (currentCharCount + itemLength) > TARGET_BATCH_CHARS) {
            batches.push({ obj: currentBatch, charCount: currentCharCount });
            currentBatch = {};
            currentCharCount = 0;
        }
        currentBatch[key] = tasksObj[key];
        currentCharCount += itemLength;
    }
    if (Object.keys(currentBatch).length > 0) {
        batches.push({ obj: currentBatch, charCount: currentCharCount });
    }

    // 🚀【修复核心点】：在 prompt 中增加了第3条“核心红线”，并对词库的要求发出了警告！
    const dictPrompt = dictStr ? `
5. 【术语表要求】：请严格遵守以下提供的《翻译专有名词词库》。只要原文出现了词库中的英文，必须统一翻译为对应的中文：
（⚠️警告：仅限替换文本！如果原文中该英文词汇没有被超链接包裹，你翻译成中文时也绝对不能把它变成超链接！）
--- 词库开始 ---
${dictStr}
--- 词库结束 ---
` : "5. 请根据《Tanki Online》（3D坦克）的游戏语境进行翻译，保证专业术语准确。";

    for (let i = 0; i < batches.length; i++) {
        const batchObj = batches[i].obj;
        const batchKeys = Object.keys(batchObj);

        // 🚀【修复核心点】：全面强化禁止 AI 自主添加 <a> 标签的禁令
        const prompt = `你是一个专业的《Tanki Online》（3D坦克）游戏 Wiki 本地化翻译引擎。
请将以下 JSON 对象中的值（包含完整 HTML 标签的代码块）翻译为简体中文。

【极端重要的要求】：
1. JSON的键名（Key）绝对不可更改。只翻译键值（Value）。
2. 【保留所有原标签，严防吞标签】：你必须原样保留所有的 HTML 标签！如果因为中英文语序不同（比如英文是 A for B，中文是 B 的 A），【必须带着完整的 HTML 标签一起移动位置】！例如原文 \`Augments for <a href="/Scorpion">Scorpion</a>\` 必须翻译为 \`<a href="/Scorpion">蝎子</a>的装备改造\`，绝对不许弄丢或删除 \`<a>\` 等任何标签！
3. 【⚠️严禁无中生有加链接（核心红线）】：绝对不允许在翻译时自行增加原文没有的 \`<a>\` 超链接或其他 HTML 标签！如果原英文词汇只是普通纯文本（没有被 \`<a>\` 等标签包裹），你翻译成中文时也必须是普通纯文本，【绝对禁止】为了强调术语而自作聪明把它变成超链接或为其添加样式！
4. 【精确翻译可见属性】：请务必翻译 HTML 标签中用于显示的属性（如 \`title="..."\`、\`alt="..."\`、\`placeholder="..."\` 等，例如 \`title="First appeared: ..."\` 必须翻译为中文）。但是对于 \`href\`、\`src\`、\`id\`、\`class\`、\`style\`、\`data-*\` 等功能性属性，【必须原样保留，绝对不能改】！
${dictPrompt}
6. 【盘古之白排版规范 - 极其重要】：
   - 中文字符与中文字符之间【绝对不要加空格或 &nbsp; 实体】，即使它们被 HTML 标签隔开！比如输出必须是 "为了用<a href="...">红宝石</a>购买"，绝对不能出现空格！
   - 【英文/数字】与【中文汉字】的交界处，请加上一个半角空格！
   - 【严禁修改数值代码】：原文中的数值（如 187.5、205.5 等）必须【绝对原样保留】！绝对不要把数字中的小数点（.）改写成逗号（,），也绝对不要在数字中间随意加空格！
7. 除了词库中的术语，其余部分请结合上下文翻译得专业流畅。如果是普通句子末尾的英文标点，请翻译为中文标点；如果是数字内的标点或HTML代码，请原样保留。
8. 绝对不要使用 Markdown 代码块包裹输出！直接输出合法的、可被 JSON.parse() 解析的纯 JSON 格式！

待翻译 HTML 块的 JSON：
${JSON.stringify(batchObj, null, 2)}`;

        let batchResult = null;
        const maxRetries = 5;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await geminiModel.generateContent({
                    contents: new Array({ role: "user", parts: new Array({ text: prompt }) }),
                    generationConfig: { temperature: 0.05 }  // 将温度再稍微调低一点，约束其创造性，让其更老实听话
                });
                let text = response.response.text();
                
                text = text.replace(/^```(json)?\s*/i, '').replace(/\s*清洁*/i, '').trim();
                
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
                            console.log(`⏳ 触发 API 配额限制！未检测到惩罚时长，强制休眠 64 秒...`);
                        }
                    }
                    
                    await new Promise(r => setTimeout(r, waitTime));
                }
            }
        }

        if (batchResult) {
            batchKeys.forEach(k => { if (batchResult[k]) results[k] = batchResult[k]; });
            console.log(`✅ 成功翻译发往 AI 的合并批次:[${i + 1} / ${batches.length}] (包含 ${batchKeys.length} 个HTML块，本次负载 ~${batches[i].charCount} 字符)`);
        } else {
            console.warn(`⚠️ 该合并批次在 ${maxRetries} 次尝试后仍失败，回退为原始 HTML。`);
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
    const blockedPrefixes = new Array('Special', 'File', 'User', 'MediaWiki', 'Template', 'Help', 'Category'); 
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

// 【步骤 1】: 抓取并准备页面数据，提取翻译块，但不直接翻译 (🚀 注意：引入 browser 参数)
async function preparePage(pageNameToProcess, sourceReplacementMap, lastEditInfoState, force = false, browser) {
    const sourceUrl = `${BASE_URL}/${pageNameToProcess}`;
    console.log(`[${pageNameToProcess}] 开始抓取页面...`);
    let page;
    let htmlContent;

    try {
        page = await browser.newPage(); // 🚀 复用全局浏览器，只开新标签页
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForSelector('#mw-content-text', { timeout: 0 });
        htmlContent = await page.content();
    } catch (error) {
        console.error(`❌ [${pageNameToProcess}] 抓取失败: ${error.message}`);
        return null;
    } finally {
        if (page) await page.close(); // 🚀 抓完立刻关闭标签页释放内存，绝对不关整个浏览器
    }
    
    const $ = cheerio.load(htmlContent);
    let rlconf = null;
    const rlconfMatch = htmlContent.match(/RLCONF\s*=\s*(\{[\s\S]*?\});/);
    if (rlconfMatch && rlconfMatch[1]) { try { rlconf = JSON.parse(rlconfMatch[1]); } catch (e) { rlconf = null; } }

    if (!rlconf || rlconf.wgArticleId === 0) return { status: 'skipped', links: new Array() };

    // 🚀 --- 【原生重定向检测优化版】 ---
    if (rlconf.wgInternalRedirectTargetUrl || rlconf.wgRedirectedFrom || (rlconf.wgPageName && sanitizePageName(rlconf.wgPageName) !== pageNameToProcess)) {
        
        // 1. 获取绝对干净的基础条目名 (例如 "Overdrives" 或 "Supplies")
        let baseTarget = rlconf.wgPageName || pageNameToProcess;
        let hash = '';

        // 2. 如果原始重定向 URL 中带有锚点(#)，把它精准提取出来
        if (rlconf.wgInternalRedirectTargetUrl) {
            const hashIndex = rlconf.wgInternalRedirectTargetUrl.indexOf('#');
            if (hashIndex !== -1) {
                hash = rlconf.wgInternalRedirectTargetUrl.substring(hashIndex);
            }
        }

        // 3. 组装最终完美的跳转目标 (例如 "Overdrives" 或 "Supplies#Boosted_Damage")
        let finalTargetUrl = sanitizePageName(baseTarget) + hash;

        // 4. 判断基础页面名是否发生了变化，如果变了说明确实触发了重定向
        if (sanitizePageName(baseTarget) !== pageNameToProcess) {
            console.log(`🔀 [${pageNameToProcess}] 探测到纯重定向跳转 -> ${finalTargetUrl}`);
            return {
                status: 'client_redirect',
                pageNameToProcess,
                targetUrl: finalTargetUrl 
            };
        }
    }

    const currentEditInfo = rlconf.wgCurRevisionId || rlconf.wgRevisionId || null;
    if (!force && currentEditInfo && lastEditInfoState[pageNameToProcess] === currentEditInfo) {
        console.log(`[${pageNameToProcess}] 页面未修改，跳过翻译。`);
        return { status: 'skipped', links: findInternalLinks($) };
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
    $('body > script').each(function() { 
        const $el = $(this); 
        if ($el.attr('src')?.startsWith('/')) $el.attr('src', BASE_URL + $el.attr('src')); 
        bodyEndScripts.push($.html(this)); 
    });
    
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
                tasksObj[chunkId] = $.html($el);
            }
        });
    }
    extractChunksToTranslate($contentContainer);
    
    const actualChunkCount = Object.keys(tasksObj).length - (tasksObj['title_0'] ? 1 : 0);
    return { 
        status: 'prepared',
        pageNameToProcess, 
        currentEditInfo,
        tasksObj,
        translatedTitle,
        headElements,
        bodyEndScripts,
        bodyClass: $('body').attr('class') || '',
        contentHtml: $contentContainer.html(), // 保存字符串以防内存溢出
        links: findInternalLinks($) 
    };
}

// 【步骤 2】: 接收该页面翻译完成的块，恢复 DOM 并写入文件
function finalizePage(preparedData, translatedResultsForPage) {
    let { pageNameToProcess, translatedTitle, headElements, bodyEndScripts, bodyClass, contentHtml } = preparedData;

    if (translatedResultsForPage['title_0']) {
        translatedTitle = formatTypography(translatedResultsForPage['title_0']);
    }

    const $contentContainer = cheerio.load(contentHtml, null, false).root();

    Object.keys(translatedResultsForPage).forEach(key => {
        if (key.startsWith('chunk_') && translatedResultsForPage[key]) {
            const $target = $contentContainer.find(`[data-translate-id="${key}"]`);
            if ($target.length) {
                $target.replaceWith(translatedResultsForPage[key]);
            }
        }
    });

    $contentContainer.find('[data-translate-id]').removeAttr('data-translate-id');

    let finalHtmlContent = $contentContainer.html();
    finalHtmlContent = formatTypography(finalHtmlContent);

    let homeButtonHtml = pageNameToProcess !== START_PAGE ? `<a href="./${START_PAGE}" style="display: inline-block; margin: 0 0 25px 0; padding: 12px 24px; background-color: #BFD5FF; color: #001926; text-decoration: none; font-weight: bold; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.2);">返回主页</a>` : '';
    
    const colorReplacementScript = `<script>function replaceColorsInDom() { const replacements = new Array({ from: /#?46DF11|rgb\\(70,\\s*223,\\s*17\\)/gi, to: '#76FF33' }, { from: /#?00D7FF/gi, to: '#00D4FF' }, { from: /#?(F86667|F33|FF3333)\\b/gi, to: '#FF6666' }, { from: /#?(FC0|FFCC00)\\b/gi, to: '#FFEE00' }, { from: /#?8C60EB/gi, to: '#D580FF' }); function applyReplacements(text) { if (!text) return text; let newText = text; for (const rule of replacements) newText = newText.replace(rule.from, rule.to); return newText; } document.querySelectorAll('[style]').forEach(el => { const orig = el.getAttribute('style'); const ns = applyReplacements(orig); if (ns !== orig) el.setAttribute('style', ns); }); document.querySelectorAll('style').forEach(tag => { const orig = tag.innerHTML; const ns = applyReplacements(orig); if (ns !== orig) tag.innerHTML = ns; }); } document.addEventListener('DOMContentLoaded', replaceColorsInDom);<\/script>`;
    bodyEndScripts.push(colorReplacementScript);

    const bilibiliPopupScript = `<script>document.addEventListener('DOMContentLoaded', function() { document.querySelectorAll('.ShowYouTubePopup').forEach(popup => { if (popup.dataset.biliHandled) return; popup.addEventListener('click', (e) => { e.stopImmediatePropagation(); if (typeof tingle === 'undefined') return; let modal = new tingle.modal({ closeMethods: new Array('button', 'escape', 'overlay') }); modal.setContent(\`<div class="report-head"><div class="report-title">观看视频</div><div class="report-close"></div></div><div style="margin: 15px 10px 10px 10px;"><iframe class="yt-video" width="640px" height="360px" src="https://player.bilibili.com/player.html?bvid=\${popup.dataset.id}" frameborder="0" allowfullscreen="allowfullscreen"></iframe></div>\`); modal.open(); modal.getContent().querySelector('.report-close').addEventListener('click', () => modal.close()); }, true); popup.dataset.biliHandled = 'true'; }); });<\/script>`;
    bodyEndScripts.push(bilibiliPopupScript);
    
    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    '); 
    const finalHtml = `<!DOCTYPE html><html lang="zh-CN" dir="ltr"><head><meta charset="UTF-8"><title>${translatedTitle}</title>${headContent}<style>@import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');body{font-family:'Rubik','M PLUS 1p',sans-serif;background-color:#001926 !important;}#mw-main-container{max-width:1200px;margin:20px auto;background-color:#001926;padding:20px;}</style></head><body class="${bodyClass}"><div id="mw-main-container">${homeButtonHtml}<div class="main-content"><div class="mw-body" id="content"><a id="top"></a><div class="mw-body-content"><div id="mw-content-text" class="mw-parser-output" lang="zh-CN" dir="ltr">${finalHtmlContent}</div></div></div></div></div>${bodyEndScripts.join('\n    ')}</body></html>`;
    
    fs.writeFileSync(path.join(OUTPUT_DIR, `${pageNameToProcess}.html`), finalHtml, 'utf-8');
    console.log(`✨[${pageNameToProcess}] 渲染及保存完成！`);
}

async function run() {
    console.log("--- 翻译任务开始 (精准防超载装箱模式 + 单体浏览器多标签页超高并发) ---");
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

    const sourceReplacementMap = getPreparedSourceDictionary();
    const dictStr = await getOnlineDictionaryString();
    
    let lastEditInfo = {};
    if (fs.existsSync(EDIT_INFO_FILE)) try { lastEditInfo = JSON.parse(fs.readFileSync(EDIT_INFO_FILE, 'utf-8')); } catch (e) {}

    const runMode = (process.env.RUN_MODE || 'FEED').toUpperCase();
    let pagesToVisit = new Array();

    switch (runMode) {
        case 'FEED': pagesToVisit = await getPagesForFeedMode(lastEditInfo); break;
        case 'CRAWLER': pagesToVisit = new Array(START_PAGE); break;
        case 'SPECIFIED':
            pagesToVisit = (process.env.PAGES_TO_PROCESS || '').split(',').map(p => sanitizePageName(p.trim())).filter(Boolean);
            break;
    }

    if (pagesToVisit.length === 0) return console.log("没有需要处理的页面，任务提前结束。");
    
    const visitedPages = new Set();
    let activeTasks = 0, pageIndex = 0;
    const isForceMode = runMode === 'FEED' || runMode === 'SPECIFIED';

    // 🌐 --- 启动全局单一共享浏览器，极大节省内存开销 ---
    console.log(`🌐 正在启动全局共享浏览器 (并发限制: ${CONCURRENCY_LIMIT} 标签页)...`);
    const globalBrowser = await puppeteer.launch({ headless: true, args: new Array('--no-sandbox', '--disable-setuid-sandbox') });

    // 🚀 --- 全局积攒批次池 ---
    let pendingPreparedPages = new Array();
    let globalTasksObj = {};
    let globalKeyMap = {}; // 记录数字短ID到具体页面与块的映射
    let globalKeyCounter = 0;
    let accumulatedChars = 0;

    // 【封装独立翻译触发器】
    const flushGlobalTranslation = async () => {
        if (pendingPreparedPages.length === 0) return;
        console.log(`\n🚀【触发全局合并翻译】: 当前池内共有 ${pendingPreparedPages.length} 个页面，总字符数 ~${accumulatedChars}！`);
        
        let globalTranslated = {};
        if (Object.keys(globalTasksObj).length > 0) {
            globalTranslated = await translateBatchWithGemini(globalTasksObj, dictStr);
        } else {
            console.log("⚠️ 积攒的页面中没有提取到任何需要翻译的英文块。");
        }

        // 拆包并分发翻译结果，恢复到各自页面的 DOM 中
        const pageTranslatedResultsMap = {};
        for (const [numericKey, transHtml] of Object.entries(globalTranslated)) {
            const mapping = globalKeyMap[numericKey];
            if (mapping) {
                const { pageName, localKey } = mapping;
                if (!pageTranslatedResultsMap[pageName]) pageTranslatedResultsMap[pageName] = {};
                pageTranslatedResultsMap[pageName][localKey] = transHtml;
            }
        }

        for (const preparedData of pendingPreparedPages) {
            const pageName = preparedData.pageNameToProcess;
            const pageResults = pageTranslatedResultsMap[pageName] || {};
            try {
                finalizePage(preparedData, pageResults);
                if (preparedData.currentEditInfo) {
                    lastEditInfo[pageName] = preparedData.currentEditInfo;
                }
            } catch (err) {
                console.error(`保存页面出错[${pageName}]:`, err);
            }
        }

        // 扫除批次缓存，清空容积准备下一批
        pendingPreparedPages = new Array();
        globalTasksObj = {};
        globalKeyMap = {};
        globalKeyCounter = 0;
        accumulatedChars = 0;
    };

    while (pageIndex < pagesToVisit.length) {
        // 判断运行时间是否超过安全阈值
        if (Date.now() - SCRIPT_START_TIME > MAX_EXECUTION_TIME_MS) {
            console.log(`\n⏳ 运行时间已达安全上限 (${MAX_EXECUTION_TIME_MINUTES} 分钟)，触发超时保护！主动退出以保存当前进度...`);
            break; 
        }

        const promises = new Array();
        
        while (activeTasks < CONCURRENCY_LIMIT && pageIndex < pagesToVisit.length) {
            const currentPageName = pagesToVisit[pageIndex++];
            if (visitedPages.has(currentPageName)) continue;
            
            visitedPages.add(currentPageName);
            activeTasks++;

            // 🚀 传入 globalBrowser，在同一个浏览器实例中新建独立标签页
            const task = preparePage(currentPageName, sourceReplacementMap, lastEditInfo, isForceMode, globalBrowser)
                .catch(err => {
                    console.error(`处理页面准备出错[${currentPageName}]:`, err);
                    return null;
                })
                .finally(() => activeTasks--);
            promises.push(task);
        }
        
        const results = await Promise.all(promises);

        for (const result of results) {
            if (!result) continue;
            
            // 🚀 --- 【处理跳转页面，生成极其轻量的静态重定向 HTML】 ---
            if (result.status === 'client_redirect') {
                const redirectHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="0; url=./${result.targetUrl}">
    <title>正在跳转...</title>
    <!-- 使用 replace 防止后退按钮卡死在跳转页 -->
    <script>window.location.replace("./${result.targetUrl}");</script>
</head>
<body style="background-color: #001926; color: white; font-family: sans-serif; text-align: center; padding-top: 50px;">
    <p>正在前往目标页面...<br>如果没有自动跳转，请 <a href="./${result.targetUrl}" style="color: #76FF33;">点击这里</a>。</p>
</body>
</html>`;
                
                fs.writeFileSync(path.join(OUTPUT_DIR, `${result.pageNameToProcess}.html`), redirectHtml, 'utf-8');
                console.log(`✨[${result.pageNameToProcess}] 已生成静态跳转页 (指向 -> ./${result.targetUrl})`);
                
                // 将被重定向到的真正主体条目（去除锚点部分）入队
                const baseTarget = sanitizePageName(result.targetUrl.split('#')[0]);
                if (runMode === 'CRAWLER' && !visitedPages.has(baseTarget) && !pagesToVisit.includes(baseTarget)) {
                    pagesToVisit.push(baseTarget);
                    console.log(`💡 真实的重定向目标[${baseTarget}] 已加入待爬取队列。`);
                }
                
                continue; // 终结当前流程，跳过翻译装箱！
            }
            // -------------------------------------------------------------

            if (result.status === 'prepared') {
                let newPageChars = 0;
                for (const htmlChunk of Object.values(result.tasksObj)) {
                    newPageChars += htmlChunk.length;
                }
                
                const actualChunkCount = Object.keys(result.tasksObj).length - (result.tasksObj['title_0'] ? 1 : 0);
                console.log(`[${result.pageNameToProcess}] 解析到 ${actualChunkCount} 个待翻区块，共计约 ${newPageChars} 字符。`);

                // 1. 预判：如果装入这个页面会导致破阈值，并且当前池子不是空的，赶紧先把旧货发掉！
                if (accumulatedChars > 0 && (accumulatedChars + newPageChars) > TARGET_BATCH_CHARS) {
                    console.log(`\n🚧[防超载装箱] 新页面加入将导致总字数(${accumulatedChars + newPageChars})突破红线(${TARGET_BATCH_CHARS})！提前清仓...`);
                    await flushGlobalTranslation();
                }

                // 2. 将此页面装入池子
                pendingPreparedPages.push(result);
                for (const[key, htmlChunk] of Object.entries(result.tasksObj)) {
                    const numericKey = `id_${globalKeyCounter++}`;
                    globalTasksObj[numericKey] = htmlChunk;
                    globalKeyMap[numericKey] = { pageName: result.pageNameToProcess, localKey: key };
                    accumulatedChars += htmlChunk.length;
                }

                // 3. 即时裁决：如果刚装进去的页面本身极其巨大（直接导致总字符 ≥ 阈值），立刻清仓！
                if (accumulatedChars >= TARGET_BATCH_CHARS) {
                    console.log(`\n🚧[到达阀门] 当前池字数达标/超标 (${accumulatedChars})，立即触发翻译下水！`);
                    await flushGlobalTranslation();
                }
            }

            if (runMode === 'CRAWLER' && result.links) {
                for (const link of result.links) {
                    if (!visitedPages.has(link) && !pagesToVisit.includes(link)) pagesToVisit.push(link);
                }
            }
        }
    }

    if (pendingPreparedPages.length > 0) {
        console.log(`\n🏁 主循环已结束 (抓取完毕或超时保护退出)，正在清理池内最后的遗留碎片...`);
        await flushGlobalTranslation();
    }

    try {
        fs.writeFileSync(EDIT_INFO_FILE, JSON.stringify(lastEditInfo, null, 2), 'utf-8');
    } catch (e) {}

    // 🚀 --- 【最后记得关闭浏览器】 ---
    if (globalBrowser) {
        await globalBrowser.close();
    }
    
    console.log("--- 进程执行完毕，任务安全结束！ ---");
}

run().catch(console.error);
