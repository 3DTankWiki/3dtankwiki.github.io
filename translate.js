// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// --- 【配置常量】 ---
// 🇷🇺 源站：俄语版 Tanki Online Wiki
const BASE_URL = 'https://ru.tankiwiki.com';
// 俄语站主页的真实页面名：标题显示为西里尔，但 wgPageName / URL 用的是拉丁转写，
// 必须与 gh-pages 上生成的文件名 Enciklopediya_igry_«Tanki_Onlayn».html 完全一致，
// 否则主页自己也会被判定成“非主页”而多出一个返回主页按钮。
const START_PAGE = 'Enciklopediya_igry_«Tanki_Onlayn»';
const RECENT_CHANGES_FEED_URL = `${BASE_URL}/api.php?action=feedrecentchanges&days=7&feedformat=atom&urlversion=1`;
const CONCURRENCY_LIMIT = 32; // 🚀 【核心】修改为 32，实现多标签页极速并发抓取
const TARGET_BATCH_CHARS = 100000; // 🚀 全局唯一合并阈值：坚守此红线
// 术语词库：仓库根目录的 translations.js（俄语 -> 中文）
const DICTIONARY_FILE = 'translations.js';
const SOURCE_DICT_FILE = 'source_replacements.js'; 
const OUTPUT_DIR = './output';

// --- 【站点声明与外观】 ---
// 「最后编辑」作者旁边追加的 AI 翻译说明
const AI_NOTE_HTML = '<span class="ai-translate-note" style="color:#8FB8D8;">（本页面由 AI 自动翻译）</span>';
// 页脚免责声明：true = 所有页面都加；false = 只在主页加
const FOOTER_ON_ALL_PAGES = true;
const SITE_FOOTER_HTML = `<footer class="site-disclaimer" style="max-width:1200px;margin:0 auto;padding:24px 20px 40px;border-top:1px solid rgba(255,255,255,.15);color:#8FB8D8;font-size:13px;line-height:1.9;text-align:center;">
<p style="margin:0;"><strong style="color:#BFD5FF;">本站为玩家社区自建的非官方 Wiki 镜像。</strong></p>
</footer>`;

// 「返回主页」按钮：照搬 tankionline.com 皮肤预览页右下角的翻页按钮
// (skins-resources/assets/index.css → .layout .skin-preview-wrapper .buttons .button)
//   常态：.125rem 半透明白边 + .5rem 圆角 + 由角落发散的 rgba(191,213,255,.15) 径向渐变，箭头 #bfd5ff
//   悬停：边框与 outline 变 #bfd5ff、::before 渐变淡入、箭头位移 10% 并变纯白
// 箭头 path 直接取自 tankionline 皮肤预览页的 React bundle（skins-resources/assets/index.js）
const HOME_BUTTON_SVG = '<svg viewBox="0 0 30 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M18 0H13.5L25.5 12L24 13.5L13.5 24H18L30 12L18 0ZM24 13.5L21 10.5H0L3 13.5H24Z" fill="#BFD5FF"/></svg>';

// 【修复 A】源站 ResourceLoader 的 startup 模块里写死了 mw.loader.addSource({"local":"/load.php"})，
// 这是相对路径，在 GitHub Pages 上会解析成 https://<你的域名>/load.php → 404，
// 导致 site / skins.tankiblue.js 等模块全部加载失败。这里在最前面劫持 script/link 的路径，补上源站域名。
const HEAD_BOOT_SCRIPT = `<script>(function(){
  var BASE = '${BASE_URL}';
  function fix(v){ return (typeof v === 'string' && v.charAt(0) === '/' && v.indexOf('//') !== 0) ? BASE + v : v; }
  ['HTMLScriptElement','HTMLLinkElement'].forEach(function(tag){
    var proto = window[tag] && window[tag].prototype;
    var prop  = tag === 'HTMLScriptElement' ? 'src' : 'href';
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      get: function(){ return d.get.call(this); },
      set: function(v){ d.set.call(this, fix(v)); }
    });
  });
  var of = window.fetch;
  if (of) window.fetch = function(u, o){ return of.call(this, (typeof u === 'string' ? fix(u) : u), o); };
  var ox = window.XMLHttpRequest && XMLHttpRequest.prototype.open;
  if (ox) XMLHttpRequest.prototype.open = function(m, u){
    var a = Array.prototype.slice.call(arguments); a[1] = fix(u); return ox.apply(this, a);
  };
})();<\/script>`;

// 【修复 B】皮肤脚本 common.js 里有大量对「皮肤外壳元素」的硬解引用，例如第 155 行：
//     const problemModal = document.querySelector('.support-block-popup');
//     const closeProblemModal = problemModal.querySelector('.close-modal-support');  // ← 我们没搬运外壳 → null → 抛错
// 一抛错整个 common.js 就中断，而下拉框的初始化 initDropDowns() 排在它后面，于是主页
// 「炮塔 / 底盘」下拉框点了没反应。这里补一组隐藏的占位元素让脚本能跑完。
const SKIN_CHROME_STUB = `<div id="skin-chrome-stub" aria-hidden="true" style="display:none !important;">
<a class="problem" href="#"></a>
<div class="close-wrapper"></div>
<div class="support-block-popup"><div class="close-modal-support"></div></div>
<div class="youtube-popup"><iframe title="stub"></iframe></div>
<div class="video-button"></div>
<div class="header-search"></div>
<div class="search-dialog"></div>
<div class="search-popup"><div class="close-wrapper"></div><div class="close-modal-search"></div></div>
<div class="news-popup"></div>
<div class="sales-block-header"></div>
<div class="navbar-main"></div>
<div class="main-navbar"></div>
</div>`;

// 页面统一样式（保守版：只做必要的修正，源站皮肤 skins.tankiblue 的原有排版一律保留）
const PAGE_STYLE = `<style>
@import url('https://fonts.googleapis.com/css2?family=M+PLUS+1p&family=Rubik&display=swap');

/* 1. 只去掉源站皮肤的背景大图，保留底色；不要用 background 简写，否则会连带清掉皮肤别的背景设定 */
html, body {
    background-image: none !important;
    background-color: #001926 !important;
}
/* 2. 让底色铺满视口，内容很短时下方不再露白 */
html { min-height: 100%; }
body { min-height: 100vh; margin: 0; font-family: 'Rubik','M PLUS 1p',sans-serif; }

/* 3. 版心容器 */
#mw-main-container {
    max-width: 1200px;
    width: 100%;
    margin: 20px auto;
    padding: 20px;
    box-sizing: border-box;
    background-color: #001926;
}

/* 4. 统一宽度：皮肤会按页面类型给内层不同的 width/float，这里只抹平尺寸，
      【不动】背景、边框、阴影、内边距，避免把皮肤原有的卡片样式一起清掉 */
#mw-main-container .main-content,
#mw-main-container .mw-body,
#mw-main-container .mw-body-content,
#mw-main-container #mw-content-text {
    max-width: none !important;
    min-width: 0 !important;
    width: auto !important;
    flex-basis: auto !important;   /* 皮肤写了 .main-content{flex:0 0 75%} */
    float: none !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    margin-top: 0 !important;
}

/* 5. 皮肤脚本 skins.tankiblue.js 会往 #mw-content-text 末尾插一条「发现错别字？Ctrl+Enter」
      的俄语提示条和一个「报告错误」标签页。它按网址里有没有 'en'/'de' 来判断语言，
      我们的域名两者都不含 → 一律显示俄语；且报错会提交到俄站编辑组，对镜像站没意义，直接隐藏。 */
#custom-report-footer,
.vectorTabs.customReport,
.customReport { display: none !important; }

/* 6. 返回主页按钮：与 tankionline 皮肤预览页翻页按钮 1:1 对齐
      （数值全部来自对官网实际渲染的 getComputedStyle 取样，根字号 13px 换算成 px 写死）
        常态 141.375x78 / border 1px rgba(255,255,255,.25) / radius 6.5px
              背景 radial-gradient(100% 100% at 100% 100%, rgba(191,213,255,.15), transparent)
              箭头 24.375x24 fill #BFD5FF
        悬停 border #BFD5FF + outline 1px #BFD5FF / ::before 渐变 opacity 0→1
              箭头 fill #fff 且位移 translate(10%)（约 2.44px）
        全部过渡 all .15s ease
      ⚠️ 手机是触屏，没有 :hover。所以下面额外加了 :active / :focus-visible，
        让点按时也能看到同样的动效，另有 @media (hover:none) 的常驻高亮兜底。 */
.home-back-btn {
    box-sizing: border-box;
    display: flex;
    width: auto;
    vertical-align: top;
    align-items: center;
    justify-content: center;
    
    min-width: 142px;
    padding: 0 24px;
    height: 78px;
    margin: 0;
    border: 1px solid rgba(255,255,255,.25);
    outline: 2px solid transparent;
    border-radius: 6.5px;
    background: radial-gradient(100% 100% at 100% 100%, rgba(191,213,255,.15) 0%, rgba(191,213,255,0) 100%);
    
    position: relative;
    cursor: pointer;
    text-decoration: none;
    -webkit-tap-highlight-color: transparent;
    transition: all .15s ease;
}
.home-back-btn::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    background: radial-gradient(100% 100% at 0% 0%, rgba(191,213,255,.25) 0%, rgba(191,213,255,.15) 100%);
    opacity: 0;
    z-index: -1;
    transition: all .15s ease;
    border-radius: inherit;
}
.home-back-btn svg {
    width: 24.375px;
    height: 24px;
    object-fit: contain;
    transform: rotate(180deg);            /* prev：箭头指向左 */
    transition: all .15s ease;
}
.home-back-btn svg path { fill: #BFD5FF; transition: all .15s ease; }

.home-back-btn:hover,
.home-back-btn:active,
.home-back-btn:focus-visible { outline: 1px solid #BFD5FF; border-color: #BFD5FF; }
.home-back-btn:hover::before,
.home-back-btn:active::before,
.home-back-btn:focus-visible::before { opacity: 1; }
.home-back-btn:hover svg,
.home-back-btn:active svg,
.home-back-btn:focus-visible svg { transform: rotate(180deg) translateX(10%); }
.home-back-btn:hover svg path,
.home-back-btn:active svg path,
.home-back-btn:focus-visible svg path { fill: #fff; }


.home-back-btn span {
    white-space: nowrap;
    color: #BFD5FF;
    font-size: 16px;
    margin-left: 10px;
    font-weight: bold;
    transition: all .15s ease;
}
.home-back-btn:hover span,
.home-back-btn:active span,
.home-back-btn:focus-visible span {
    color: #fff;
    transform: translateX(-4px);
}
@media (max-width: 480px) {
    .home-back-btn span { font-size: 14px; margin-left: 8px; }
}

/* 触屏设备（手机/平板）没有悬停，按钮默认就给到更亮的描边，避免看起来像“没样式” */
@media (hover: none) {
    .home-back-btn { border-color: rgba(191,213,255,.55); }
    .home-back-btn svg path { fill: #CFE0FF; }
}
/* 窄屏适当缩小，保持官网比例 141.375:78 */
@media (max-width: 480px) {
    .home-back-btn { width: auto; min-width: 106px; padding: 0 16px; height: 58px; margin: 0; }
    .home-back-btn svg { width: 20px; height: 19.7px; }
}

/* 7. 移动端：源站容器 padding + 我们的 20px 叠加后两侧空太多，正文被挤成窄条 */
@media (max-width: 768px) {
    #mw-main-container { padding: 10px; margin: 8px auto; }
    
    /* 主页那些写死 width:55% / 45% 的分栏在窄屏下强制单列 */
    #mw-content-text .navigationContainerContent > div,
    #mw-content-text [style*="width: 55%"],
    #mw-content-text [style*="width:55%"],
    #mw-content-text [style*="width: 45%"],
    #mw-content-text [style*="width:45%"] { width: 100% !important; }
}
@media (max-width: 480px) {
    #mw-main-container { padding: 6px; margin: 4px auto; }
}

/* 8. 防止宽表格 / 大图撑破版心产生横向滚动 */
#mw-content-text img { max-width: 100%; height: auto; }
#mw-content-text table { max-width: 100%; }

/* ⚠️ 下面这组是「彻底清掉皮肤面板样式」的选项，默认注释掉。
   只有当内层还残留不想要的白底/边框时再启用，启用后页面会变得很素：
#mw-main-container .mw-body,
#mw-main-container .mw-body-content {
    background: transparent !important;
    border: 0 !important;
    box-shadow: none !important;
}
*/
</style>`;
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');

// 【新增】超时保护相关常量 (避免被 GitHub Actions 6小时强杀)
const MAX_EXECUTION_TIME_MINUTES = parseInt(process.env.MAX_EXECUTION_TIME || '345', 10); // 默认 5小时45分钟
const MAX_EXECUTION_TIME_MS = MAX_EXECUTION_TIME_MINUTES * 60 * 1000;
const SCRIPT_START_TIME = Date.now();

// 初始化 Gemini 客户端
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" });

// 页面名一律使用「解码后的西里尔原文」形式（如 Устройства），
// 若传入的是从地址栏复制的百分号编码（%D0%A3%D1%81...），这里自动解码，避免出现两套文件名
const sanitizePageName = (name) => {
    if (!name) return name;
    if (/%[0-9A-Fa-f]{2}/.test(name)) {
        try { name = decodeURIComponent(name); } catch (e) { /* 非法编码则保持原样 */ }
    }
    return name.replaceAll(' ', '_');
};

// 需要屏蔽的命名空间（俄站链接里英文规范名和俄语本地化名两种写法都可能出现）
const NS_BLOCKLIST = new Array(
    'Special', 'File', 'Image', 'User', 'MediaWiki', 'Template', 'Help', 'Category', 'Talk',
    'Служебная', 'Файл', 'Изображение', 'Участник', 'Участница', 'Шаблон',
    'Справка', 'Категория', 'Обсуждение', 'Обсуждение_участника', 'Обсуждение_участницы',
    'Обсуждение_файла', 'Обсуждение_шаблона', 'Обсуждение_категории', 'МедиаВики'
);

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
            const blockedPrefixes = NS_BLOCKLIST.map(p => p + ':');
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

function getDictionaryString() {
    const filePath = path.resolve(__dirname, DICTIONARY_FILE);
    if (!fs.existsSync(filePath)) {
        console.warn(`⚠️ 未找到术语词库 ${DICTIONARY_FILE}，将不使用专有词库提示AI。`);
        return "";
    }
    try {
        const scriptContent = fs.readFileSync(filePath, 'utf-8');
        const dictObj = new Function(`${scriptContent}; return replacementDict;`)();

        let dictStr = "";
        for (const [ru, zh] of Object.entries(dictObj || {})) {
            dictStr += `${ru} -> ${zh}\n`;
        }
        console.log(`✅ 成功加载翻译词典 ${DICTIONARY_FILE}（${Object.keys(dictObj || {}).length} 条），将作为指令发送给 AI。`);
        return dictStr;
    } catch (error) {
        console.warn(`⚠️ 解析词库 ${DICTIONARY_FILE} 失败，将不使用专有词库提示AI: ${error.message}`);
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

// 检测文本中是否还有未翻译的原文字符：必须包含西里尔字母，
// 否则俄语正文会被判定为“无需翻译”而整页跳过（拉丁字母一并检测，覆盖 Wasp 等原样保留的词）
function containsSourceText(text) { return /[\u0400-\u04FFa-zA-Z]/.test(text); }

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

    // 盘古之白：西文/数字/西里尔字母 与 汉字 之间加空格
    res = res.replace(/([a-zA-Z0-9\u0400-\u04FF])([\u4e00-\u9fa5])/g, '$1 $2');
    res = res.replace(/([\u4e00-\u9fa5])([a-zA-Z0-9\u0400-\u04FF])/g, '$1 $2');

    res = res.replace(/([a-zA-Z0-9\u0400-\u04FF])(<\/[a-zA-Z0-9]+>)([\u4e00-\u9fa5])/g, '$1$2 $3');
    res = res.replace(/([\u4e00-\u9fa5])(<\/[a-zA-Z0-9]+>)([a-zA-Z0-9\u0400-\u04FF])/g, '$1$2 $3');
    res = res.replace(/([a-zA-Z0-9\u0400-\u04FF])(<[a-zA-Z0-9]+[^>]*>)([\u4e00-\u9fa5])/g, '$1 $2$3');
    res = res.replace(/([\u4e00-\u9fa5])(<[a-zA-Z0-9]+[^>]*>)([a-zA-Z0-9\u0400-\u04FF])/g, '$1 $2$3');

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
5. 【术语表要求】：请严格遵守以下提供的《翻译专有名词词库》。只要原文出现了词库中的俄文，必须统一翻译为对应的中文：
（⚠️警告：仅限替换文本！如果原文中该俄文词汇没有被超链接包裹，你翻译成中文时也绝对不能把它变成超链接！）
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
2. 【保留所有原标签，严防吞标签】：你必须原样保留所有的 HTML 标签！如果因为中俄文语序不同（比如俄文是 A для B，中文是 B 的 A），【必须带着完整的 HTML 标签一起移动位置】！例如原文 \`Улучшения для <a href="/Skorpion">Скорпиона</a>\` 必须翻译为 \`<a href="/Scorpion">蝎子</a>的装备改造\`，绝对不许弄丢或删除 \`<a>\` 等任何标签！
3. 【⚠️严禁无中生有加链接（核心红线）】：绝对不允许在翻译时自行增加原文没有的 \`<a>\` 超链接或其他 HTML 标签！如果原俄文词汇只是普通纯文本（没有被 \`<a>\` 等标签包裹），你翻译成中文时也必须是普通纯文本，【绝对禁止】为了强调术语而自作聪明把它变成超链接或为其添加样式！
4. 【精确翻译可见属性】：请务必翻译 HTML 标签中用于显示的属性（如 \`title="..."\`、\`alt="..."\`、\`placeholder="..."\` 等，例如 \`title="Впервые появился: ..."\` 必须翻译为中文）。但是对于 \`href\`、\`src\`、\`id\`、\`class\`、\`style\`、\`data-*\` 等功能性属性，【必须原样保留，绝对不能改】！
${dictPrompt}
6. 【盘古之白排版规范 - 极其重要】：
   - 中文字符与中文字符之间【绝对不要加空格或 &nbsp; 实体】，即使它们被 HTML 标签隔开！比如输出必须是 "为了用<a href="...">红宝石</a>购买"，绝对不能出现空格！
   - 【俄文/英文/数字】与【中文汉字】的交界处，请加上一个半角空格！
   - 【严禁修改数值代码】：原文中的数值（如 187.5、205.5 等）必须【绝对原样保留】！绝对不要把数字中的小数点（.）改写成逗号（,），也绝对不要在数字中间随意加空格！
7. 除了词库中的术语，其余部分请结合上下文翻译得专业流畅。如果是普通句子末尾的俄文标点，请翻译为中文标点；如果是数字内的标点或HTML代码，请原样保留。
8. 绝对不要使用 Markdown 代码块包裹输出！直接输出合法的、可被 JSON.parse() 解析的纯 JSON 格式！

待翻译 HTML 块的 JSON：
${JSON.stringify(batchObj, null, 2)}`;

        let batchResult = null;
        const maxRetries = 10;
        
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
    if (!href) return null; 
    let url; 
    try { url = new URL(href, BASE_URL); } catch (e) { return null; } 
    if (url.hostname !== new URL(BASE_URL).hostname) return null; 
    
    let pathname = decodeURIComponent(url.pathname); 
    if (pathname.startsWith('/w/index.php')) return null; 
    
    let pageName = pathname.substring(1); 
    const blockedPrefixes = NS_BLOCKLIST; 
    const blockedPrefixRegex = new RegExp(`^(${blockedPrefixes.join('|')}):`, 'i'); 
    
    // 🚀 核心修复：屏蔽常见资源/附件后缀，并直接拦截 images 目录
    const isResourceFile = /\.(css|js|png|jpg|jpeg|gif|svg|ico|php|zip|rar|7z|pdf|doc|docx|xls|xlsx|txt|csv|mp3|mp4|webm|avi)$/i.test(pageName);
    
    if (!pageName || blockedPrefixRegex.test(pageName) || pageName.includes('#') || isResourceFile || pageName.startsWith('images/')) {
        return null; // 返回 null 后，DOM 转换逻辑会自动将它变成带域名的绝对路径
    }
    
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
    
    // 计算当前页面的目录层级深度，用于生成正确的相对路径前缀
    const depth = (pageNameToProcess.match(/\//g) ||[]).length;
    const relPrefix = depth === 0 ? './' : '../'.repeat(depth);

    const $factBoxContent = $contentContainer.find('.random-text-box > div:last-child'); 
    if ($factBoxContent.length > 0) { 
        $factBoxContent.html('<p id="dynamic-fact-placeholder" style="margin:0;">正在加载有趣的事实...</p>'); 
        // 动态引入 relPrefix，确保子目录也能正确读取到根目录的 facts.json
        bodyEndScripts.push(`<script>document.addEventListener('DOMContentLoaded', function() { fetch('${relPrefix}facts.json').then(r=>r.json()).then(f=>{ document.getElementById('dynamic-fact-placeholder').innerHTML = f[Math.floor(Math.random() * f.length)].cn; }).catch(()=>{}); });<\/script>`); 
    }

    $contentContainer.find('a').each(function() { 
        const $el = $(this); const href = $el.attr('href'); const internalName = getPageNameFromWikiLink(href); 
        // 使用相对层级前缀替换写死的 ./
        if (internalName) $el.attr('href', `${relPrefix}${encodeURIComponent(internalName).replace(/%2F/gi, '/')}`); 
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
    if (containsSourceText(translatedTitle)) tasksObj['title_0'] = translatedTitle;
    
    let chunkIndex = 0;
    function extractChunksToTranslate($parent) {
        $parent.children().each((_, el) => {
            const $el = $(el);
            const outerHtml = $.html($el);
            if (!containsSourceText(outerHtml)) return;
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

    const $c = cheerio.load(contentHtml, null, false);
    const $contentContainer = $c.root();

    Object.keys(translatedResultsForPage).forEach(key => {
        if (key.startsWith('chunk_') && translatedResultsForPage[key]) {
            const $target = $contentContainer.find(`[data-translate-id="${key}"]`);
            if ($target.length) {
                $target.replaceWith(translatedResultsForPage[key]);
            }
        }
    });

    $contentContainer.find('[data-translate-id]').removeAttr('data-translate-id');

    // 在「最后编辑：某某 某年某月某日」这一行的作者旁边，追加 AI 翻译声明
    let aiNoteAdded = false;
    $contentContainer.find('small, .lastmod, .printfooter').each(function () {
        if (aiNoteAdded) return;
        const $el = $c(this);
        if (/最后编辑|最後編輯|最后修改|Последне|Last edit/i.test($el.text())) {
            $el.append(' ' + AI_NOTE_HTML);
            aiNoteAdded = true;
        }
    });
    // 源页面没有「最后编辑」行时的兜底：在正文末尾单独补一条
    if (!aiNoteAdded) {
        $contentContainer.append(`<div align="right" style="margin-top:16px;"><small>${AI_NOTE_HTML}</small></div>`);
    }

    let finalHtmlContent = $contentContainer.html();
    finalHtmlContent = formatTypography(finalHtmlContent);

    // 动态计算“返回主页”按钮的正确层级退回路径
    const depth = (pageNameToProcess.match(/\//g) ||[]).length;
    const relPrefix = depth === 0 ? './' : '../'.repeat(depth);
    let homeButtonHtml = pageNameToProcess !== START_PAGE
        ? `<div class="home-btn-wrapper" style="padding: 10px 0; margin-bottom: 25px; display: block !important; position: relative; z-index: 9999;"><a class="home-back-btn" href="${relPrefix}${encodeURIComponent(START_PAGE)}" title="返回主页" aria-label="返回主页">${HOME_BUTTON_SVG}<span>返回主页</span></a></div>`
        : '';
    
    const colorReplacementScript = `<script>function replaceColorsInDom() { const replacements = new Array({ from: /#?46DF11|rgb\\(70,\\s*223,\\s*17\\)/gi, to: '#76FF33' }, { from: /#?00D7FF/gi, to: '#00D4FF' }, { from: /#?(F86667|F33|FF3333)\\b/gi, to: '#FF6666' }, { from: /#?(FC0|FFCC00)\\b/gi, to: '#FFEE00' }, { from: /#?8C60EB/gi, to: '#D580FF' }); function applyReplacements(text) { if (!text) return text; let newText = text; for (const rule of replacements) newText = newText.replace(rule.from, rule.to); return newText; } document.querySelectorAll('[style]').forEach(el => { const orig = el.getAttribute('style'); const ns = applyReplacements(orig); if (ns !== orig) el.setAttribute('style', ns); }); document.querySelectorAll('style').forEach(tag => { const orig = tag.innerHTML; const ns = applyReplacements(orig); if (ns !== orig) tag.innerHTML = ns; }); } document.addEventListener('DOMContentLoaded', replaceColorsInDom);<\/script>`;
    bodyEndScripts.push(colorReplacementScript);

    const bilibiliPopupScript = `<script>document.addEventListener('DOMContentLoaded', function() { document.querySelectorAll('.ShowYouTubePopup').forEach(popup => { if (popup.dataset.biliHandled) return; popup.addEventListener('click', (e) => { e.stopImmediatePropagation(); if (typeof tingle === 'undefined') return; let modal = new tingle.modal({ closeMethods: new Array('button', 'escape', 'overlay') }); modal.setContent(\`<div class="report-head"><div class="report-title">观看视频</div><div class="report-close"></div></div><div style="margin: 15px 10px 10px 10px;"><iframe class="yt-video" width="640px" height="360px" src="https://player.bilibili.com/player.html?bvid=\${popup.dataset.id}" frameborder="0" allowfullscreen="allowfullscreen"></iframe></div>\`); modal.open(); modal.getContent().querySelector('.report-close').addEventListener('click', () => modal.close()); }, true); popup.dataset.biliHandled = 'true'; }); });<\/script>`;
    bodyEndScripts.push(bilibiliPopupScript);
    
    const headContent = headElements.filter(el => !el.toLowerCase().startsWith('<title>')).join('\n    '); 
    const footerHtml = (FOOTER_ON_ALL_PAGES || pageNameToProcess === START_PAGE) ? SITE_FOOTER_HTML : '';
    const finalHtml = `<!DOCTYPE html><html lang="zh-CN" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">${HEAD_BOOT_SCRIPT}<title>${translatedTitle}</title>${headContent}${PAGE_STYLE}</head><body class="${bodyClass}">${SKIN_CHROME_STUB}<div id="mw-main-container">${homeButtonHtml}<div class="main-content"><div class="mw-body" id="content"><a id="top"></a><div class="mw-body-content"><div id="mw-content-text" class="mw-parser-output" lang="zh-CN" dir="ltr">${finalHtmlContent}</div></div></div></div></div>${footerHtml}${bodyEndScripts.join('\n    ')}</body></html>`;
    
    // 核心修复点：若有父目录，自动递归创建
    const outputPath = path.join(OUTPUT_DIR, `${pageNameToProcess}.html`);
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, finalHtml, 'utf-8');
    console.log(`✨[${pageNameToProcess}] 渲染及保存完成！`);
}

async function run() {
    console.log("--- 翻译任务开始 (精准防超载装箱模式 + 单体浏览器多标签页超高并发) ---");
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

    const sourceReplacementMap = getPreparedSourceDictionary();
    const dictStr = getDictionaryString();
    
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
            console.log("⚠️ 积攒的页面中没有提取到任何需要翻译的源语言文本块。");
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
                const depth = (result.pageNameToProcess.match(/\//g) ||[]).length;
                const relPrefix = depth === 0 ? './' : '../'.repeat(depth);

                const redirectHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="0; url=${relPrefix}${encodeURI(result.targetUrl)}">
    <title>正在跳转...</title>
    <!-- 使用 replace 防止后退按钮卡死在跳转页 -->
    <script>window.location.replace("${relPrefix}${encodeURI(result.targetUrl)}");</script>
</head>
<body style="background-color: #001926; color: white; font-family: sans-serif; text-align: center; padding-top: 50px;">
    <p>正在前往目标页面...<br>如果没有自动跳转，请 <a href="${relPrefix}${encodeURI(result.targetUrl)}" style="color: #76FF33;">点击这里</a>。</p>
</body>
</html>`;
                
                // 核心修复：即使重定向页存在于子级目录中，也能安全写入
                const outputPath = path.join(OUTPUT_DIR, `${result.pageNameToProcess}.html`);
                const outputDir = path.dirname(outputPath);
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                }
                fs.writeFileSync(outputPath, redirectHtml, 'utf-8');
                console.log(`✨[${result.pageNameToProcess}] 已生成静态跳转页 (指向 -> ${relPrefix}${result.targetUrl})`);
                
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
