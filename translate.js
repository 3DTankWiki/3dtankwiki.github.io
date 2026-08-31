// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
// 【新增】diff 链接清单的生成逻辑（单独模块，便于脱离 Puppeteer 单独测试）
const { renderDiffLinksMarkdown } = require('./diff_links.js');

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

// 【新增】源站双端 diff 链接清单：写在 main 分支根目录，每次有页面更新时整体覆盖
// 说明见 writeDiffLinksFile()：oldRev 取自 last_edit_info.json 里上一次翻译时记录的版本
const DIFF_LINKS_FILE = path.join(__dirname, 'diff_links.md');
// RUN   = 文件包含「本次进程」所有已更新页面（默认，跨批累计，每批重写一次）
// BATCH = 文件只包含「当前这一批」已更新页面
const DIFF_LINKS_SCOPE = (process.env.DIFF_LINKS_SCOPE || 'RUN').toUpperCase();

// --- 【站点声明与外观】 ---
// 「最后编辑」作者旁边追加的 AI 翻译说明
const AI_NOTE_HTML = '<span class="ai-translate-note" style="color:#8FB8D8;">（由 AI 自动翻译）</span>';
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
    margin-top: 0 !important;       /* 核心：清空原站皮肤的负 margin-top */
    margin-bottom: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    top: 0 !important;
    transform: none !important;
    position: relative !important;
    z-index: 1 !important;          /* 保证正文层级低于按钮 */
}

/* 5. 皮肤脚本 skins.tankiblue.js 会往 #mw-content-text 末尾插一条「发现错别字？Ctrl+Enter」
      的俄语提示条和一个「报告错误」标签页。它按网址里有没有 'en'/'de' 来判断语言，
      我们的域名两者都不含 → 一律显示俄语；且报错会提交到俄站编辑组，对镜像站没意义，直接隐藏。 */
#custom-report-footer,
.vectorTabs.customReport,
.customReport { display: none !important; }

/* 6. 返回按钮包裹容器：独占一行并强制最高层级 */
.home-btn-wrapper {
    display: block !important;
    width: 100% !important;
    box-sizing: border-box !important;
    padding: 10px 0 20px 0 !important;
    margin: 0 !important;
    position: relative !important;
    z-index: 9999 !important;       /* 核心：永远置于最顶层 */
    clear: both !important;
    overflow: visible !important;
}

/* 7. 返回主页按钮：与 tankionline 皮肤预览页翻页按钮 1:1 对齐 */
.home-back-btn {
    box-sizing: border-box !important;
    display: inline-flex !important;
    width: auto !important;
    align-items: center !important;
    justify-content: center !important;
    isolation: isolate !important;
    
    min-width: 142px !important;
    padding: 0 24px !important;
    height: 78px !important;
    margin: 0 !important;
    border: 1px solid rgba(255,255,255,.25) !important;
    outline: 2px solid transparent !important;
    border-radius: 6.5px !important;
    background: radial-gradient(100% 100% at 100% 100%, rgba(191,213,255,.15) 0%, rgba(191,213,255,0) 100%) !important;
    
    position: relative !important;
    z-index: 10000 !important;
    cursor: pointer !important;
    text-decoration: none !important;
    -webkit-tap-highlight-color: transparent !important;
    transition: all .15s ease !important;
    overflow: visible !important;
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
    pointer-events: none;
}
.home-back-btn svg {
    width: 24.375px;
    height: 24px;
    object-fit: contain;
    transform: rotate(180deg);
    transition: all .15s ease;
    flex-shrink: 0;
}
.home-back-btn svg path { fill: #BFD5FF; transition: all .15s ease; }

.home-back-btn:hover,
.home-back-btn:active,
.home-back-btn:focus-visible { outline: 1px solid #BFD5FF !important; border-color: #BFD5FF !important; }
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
    color: #BFD5FF;
    font-size: 16px;
    margin-left: 10px;
    font-weight: bold;
    transition: all .15s ease;
    white-space: nowrap;
}
.home-back-btn:hover span,
.home-back-btn:active span,
.home-back-btn:focus-visible span {
    color: #fff;
    transform: translateX(-4px);
}

/* 触屏设备（手机/平板）没有悬停，按钮默认就给到更亮的描边，避免看起来像“没样式” */
@media (hover: none) {
    .home-back-btn { border-color: rgba(191,213,255,.55) !important; }
    .home-back-btn svg path { fill: #CFE0FF; }
}

/* 移动端/窄屏自适应尺寸 */
@media (max-width: 480px) {
    .home-back-btn {
        min-width: 106px !important;
        padding: 0 16px !important;
        height: 58px !important;
        margin-left: 10px !important;
    }
    .home-back-btn svg { width: 20px !important; height: 19.7px !important; }
    .home-back-btn span { font-size: 14px !important; margin-left: 8px !important; }
}

/* 8. 移动端容器 Padding */
@media (max-width: 768px) {
    #mw-main-container { padding: 10px !important; margin: 8px auto !important; }
    .home-back-btn { margin-left: 10px !important; }
    #mw-content-text .navigationContainerContent > div,
    #mw-content-text [style*="width: 55%"],
    #mw-content-text [style*="width:55%"],
    #mw-content-text [style*="width: 45%"],
    #mw-content-text [style*="width:45%"] { width: 100% !important; }
}
@media (max-width: 480px) {
    #mw-main-container { padding: 6px !important; margin: 4px auto !important; }
}

/* 9. 防止宽表格 / 大图撑破版心 */
#mw-content-text img { max-width: 100%; height: auto; }
#mw-content-text table { max-width: 100%; }

/* 10. 目录（TOC）修复，全局生效：
    a) 皮肤把目录折叠按钮的文字放在 CSS 伪元素里渲染，而不是 HTML 文本：
         .toctogglecheckbox:checked  + .toctitle .toctogglelabel::after → content:'показать'
         .toctogglecheckbox:not(:checked) + .toctitle .toctogglelabel::after → content:'скрыть'
       AI 翻译只处理 HTML 文本，摸不到 CSS content，所以这个按钮永远是俄语，必须在这里覆盖成中文。
    b) 皮肤的响应式 CSS 里写了 @media screen and (max-width:768px){ #toc{display:none} }，
       导致手机端整个目录被隐藏。这里恢复显示，并配合下方 TOC_MOBILE_COLLAPSE_SCRIPT：
       移动端默认折叠，只占一行「目录 [展开]」，避免长目录把正文挤到屏幕外。 */
#toc .toctogglecheckbox:checked + .toctitle .toctogglelabel::after { content: '展开' !important; }
#toc .toctogglecheckbox:not(:checked) + .toctitle .toctogglelabel::after { content: '收起' !important; }
@media screen and (max-width: 768px) {
    #toc { display: table !important; }
}

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
const MAX_EXECUTION_TIME_MINUTES = parseInt(process.env.MAX_EXECUTION_TIME || '330', 10); // 默认 5小时30分钟
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

// === 【新增】页面状态变化 → 源站双端 diff 链接 ===
// runDiffRecords 记录本次进程内所有「修订号发生变化」的页面（key = 页面名，重复出现以最新为准）。
// 关键点：oldRev 必须在 lastEditInfo 被覆盖【之前】取到，否则就退化成「本次 vs 本次」的无效 diff。
const runDiffRecords = new Map();

function rememberPageRevisionChange(pageName, oldRev, newRev, runMode) {
    if (!newRev) return null;
    if (String(newRev) === String(oldRev || '')) return null; // 强制重翻但版本未变，不产生 diff
    const record = {
        page: pageName,
        oldRev: oldRev ? String(oldRev) : null, // null = 首次收录，没有「上一版」
        newRev: String(newRev),
        type: oldRev ? 'update' : 'new',
        mode: runMode || 'FEED',
        at: new Date().toISOString()
    };
    runDiffRecords.set(pageName, record);
    return record;
}

// 用当前作用域内的记录【整体覆盖】diff_links.md（不追加历史）
function writeDiffLinksFile(records, runMode) {
    if (!records || records.length === 0) return;
    try {
        const markdown = renderDiffLinksMarkdown(records, {
            generatedAt: new Date().toISOString(),
            runMode: runMode,
            scope: DIFF_LINKS_SCOPE
        });
        fs.writeFileSync(DIFF_LINKS_FILE, markdown, 'utf-8');
        console.log(`🔗 已写入源站 diff 链接清单 -> ${path.basename(DIFF_LINKS_FILE)}（${records.length} 条，整体覆盖）`);
    } catch (error) {
        // 写清单失败绝不能影响主流程
        console.warn(`⚠️ 写入 ${path.basename(DIFF_LINKS_FILE)} 失败: ${error.message}`);
    }
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
        const src = $el.attr('src') || '';
        // 剔除源站注入型脚本（upgradesCalculator.js / paints.js）：它们会在浏览器里
        // 二次注入「计算器模式」/「迷彩搜索」控件，造成重复的俄语按钮 / 两个搜索框。
        // 由 finalizePage 里注入的仓库自托管「逻辑版」脚本替代（不重复注入、计算器不依赖 .total）。
        if (/skins\/TankiBlue\/resources\/scripts\/upgradesCalculator\.js/.test(src) ||
            /skins\/TankiBlue\/resources\/scripts\/paints\.js/.test(src)) {
            return;
        }
        if (src.startsWith('/')) $el.attr('src', BASE_URL + src); 
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
    // 源站实际使用的「随机趣闻」框是 .interestingFact（不是旧的 .random-text-box）。
    // 这类框内容固定写死一条，不会真正随机读取 facts.json；这里补上随机化逻辑。
    const hasInterestingFact = $contentContainer.find('.interestingFact').length > 0;
    if (hasInterestingFact) {
        // 把内容 div（带 `font-size: 95%; padding-top:10px` 样式的那一层）替换为占位符
        $contentContainer.find('.interestingFact').each(function() {
            const $content = $(this).find('div[style*="padding-top"]');
            if ($content.length) $content.html('<p style="margin:0;" data-fact-placeholder="true">正在加载有趣的事实...</p>');
        });
        bodyEndScripts.push(`<script>document.addEventListener('DOMContentLoaded', function() {
            fetch('${relPrefix}facts.json').then(r=>r.json()).then(function(facts) {
                if (!facts || !facts.length) return;
                var picks = [];
                document.querySelectorAll('.interestingFact').forEach(function(box) {
                    var content = box.querySelector('div[style*="padding-top"]');
                    if (content) picks.push(content);
                });
                if (!picks.length) return;
                var f = facts[Math.floor(Math.random() * facts.length)];
                var cn = (f && f.cn) ? f.cn : '';
                if (!cn) return;
                picks.forEach(function(content) { content.innerHTML = '<p style="margin:0;">' + cn + '</p>'; });
            }).catch(function(){});
        });<\/script>`);
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

    // 目录标题兜底：AI 漏翻时（标题里仍残留西里尔字母）强制改成「目录」，不依赖 AI
    $contentContainer.find('#mw-toc-heading').each(function () {
        if (containsSourceText($c(this).text())) $c(this).text('目录');
    });

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
        ? `<div class="home-btn-wrapper"><a class="home-back-btn" href="${relPrefix}${encodeURIComponent(START_PAGE)}" title="返回主页" aria-label="返回主页">${HOME_BUTTON_SVG}<span>返回主页</span></a></div>`
        : '';
    
    const colorReplacementScript = `<script>function replaceColorsInDom() { const replacements = new Array({ from: /#?46DF11|rgb\\(70,\\s*223,\\s*17\\)/gi, to: '#76FF33' }, { from: /#?00D7FF/gi, to: '#00D4FF' }, { from: /#?(F86667|F33|FF3333)\\b/gi, to: '#FF6666' }, { from: /#?(FC0|FFCC00)\\b/gi, to: '#FFEE00' }, { from: /#?8C60EB/gi, to: '#D580FF' }); function applyReplacements(text) { if (!text) return text; let newText = text; for (const rule of replacements) newText = newText.replace(rule.from, rule.to); return newText; } document.querySelectorAll('[style]').forEach(el => { const orig = el.getAttribute('style'); const ns = applyReplacements(orig); if (ns !== orig) el.setAttribute('style', ns); }); document.querySelectorAll('style').forEach(tag => { const orig = tag.innerHTML; const ns = applyReplacements(orig); if (ns !== orig) tag.innerHTML = ns; }); } document.addEventListener('DOMContentLoaded', replaceColorsInDom);<\/script>`;
    bodyEndScripts.push(colorReplacementScript);

    const bilibiliPopupScript = `<script>document.addEventListener('DOMContentLoaded', function() { document.querySelectorAll('.ShowYouTubePopup').forEach(popup => { if (popup.dataset.biliHandled) return; popup.addEventListener('click', (e) => { e.stopImmediatePropagation(); if (typeof tingle === 'undefined') return; let modal = new tingle.modal({ closeMethods: new Array('button', 'escape', 'overlay') }); modal.setContent(\`<div class="report-head"><div class="report-title">观看视频</div><div class="report-close"></div></div><div style="margin: 15px 10px 10px 10px;"><iframe class="yt-video" width="640px" height="360px" src="https://player.bilibili.com/player.html?bvid=\${popup.dataset.id}" frameborder="0" allowfullscreen="allowfullscreen"></iframe></div>\`); modal.open(); modal.getContent().querySelector('.report-close').addEventListener('click', () => modal.close()); }, true); popup.dataset.biliHandled = 'true'; }); });<\/script>`;
    bodyEndScripts.push(bilibiliPopupScript);

    // 移动端目录：皮肤响应式 CSS 在 ≤768px 默认隐藏 #toc（已由 PAGE_STYLE 恢复显示），
    // 这里再让移动端默认折叠成「目录 [展开]」一行。源站 mediawiki.toc 模块只在
    // hidetoc cookie 为 '1' 时才设置折叠状态，不会覆盖这里的默认值。
    const tocMobileScript = `<script>document.addEventListener('DOMContentLoaded', function() { var cb = document.getElementById('toctogglecheckbox'); if (cb && window.matchMedia && window.matchMedia('(max-width: 768px)').matches) cb.checked = true; });<\/script>`;
    bodyEndScripts.push(tocMobileScript);

    // ⚠️ 通用去重 + 功能脚本：由于上面已剔除源站 upgradesCalculator.js / paints.js，
    // 这里补上仓库自托管的「逻辑版」脚本，让静态 HTML 里已经翻译好的控件正常工作：
    //   - 计算器：不依赖 .total（修复勾选崩溃与重复加和），不重复注入
    //   - 迷彩搜索/筛选/悬停：只绑定功能，不重复注入搜索框
    //   - 运行时去重兜底：若仍有重复控件则只保留第一个（已翻译的中文控件）
    const calcLogicScript = `<script>document.addEventListener('DOMContentLoaded', function() {
        document.querySelectorAll('.item-upgrades-block').forEach(function(block) {
            var table = block.querySelector('.item-upgrades-table');
            if (!table) return;
            var cb = block.querySelector('input[type="checkbox"]');
            var discounts = block.querySelector('.discounts');
            var sum = block.querySelector('.sum');
            var input = block.querySelector('.calc-input-group .delay');
            var resetBtn = block.querySelector('.reset');
            var cells = table.querySelectorAll('tr:not(.nocalc) td:nth-last-child(-n+2)');
            var i;
            for (i = 0; i < cells.length; i++) cells[i].dataset.initial = cells[i].innerHTML;
            function colSum(sel) { var s = 0; table.querySelectorAll(sel).forEach(function(c){ var v = parseInt(c.textContent); if (!isNaN(v)) s += v; }); return s; }
            var grandSpeed = colSum('tr:not(.nocalc) td:nth-last-child(1)');
            var grandDelay = colSum('tr:not(.nocalc) td:nth-last-child(2)');
            var speedCell = sum ? sum.querySelector('td.speed') : null;
            var delayCell = sum ? sum.querySelector('td.delay') : null;
            function cellCol(cell) { var tds = Array.prototype.slice.call(cell.parentElement.querySelectorAll('td')); var idx = tds.indexOf(cell); return idx === tds.length - 1 ? 'speed' : 'delay'; }
            function refresh(on) {
                if (on) {
                    if (discounts) { discounts.style.display = 'flex'; discounts.classList.remove('hidden'); }
                    if (sum) sum.classList.remove('hidden');
                    if (speedCell) speedCell.textContent = String(grandSpeed);
                    if (delayCell) delayCell.textContent = String(grandDelay);
                    for (i = 0; i < cells.length; i++) cells[i].classList.add('highlighted');
                } else {
                    if (discounts) { discounts.style.display = 'none'; discounts.classList.add('hidden'); }
                    if (sum) sum.classList.add('hidden');
                    doReset();
                }
            }
            function toggleCell(cell) {
                var target = cellCol(cell) === 'speed' ? speedCell : delayCell;
                if (!target) return;
                var v = parseInt(cell.textContent); if (isNaN(v)) return;
                var cur = parseInt(target.textContent) || 0;
                cell.classList.toggle('highlighted');
                target.textContent = String(cell.classList.contains('highlighted') ? cur + v : cur - v);
            }
            function applyDiscount() {
                var val = parseInt(input.value); if (isNaN(val)) val = 0;
                if (val > 95) val = 95; if (val < 0) val = 0; input.value = val;
                var disc = (100 - val) / 100;
                for (i = 0; i < cells.length; i++) cells[i].textContent = Math.ceil((parseInt(cells[i].dataset.initial) || 0) * disc);
                if (speedCell) speedCell.textContent = '0';
                if (delayCell) delayCell.textContent = '0';
                ['speed','delay'].forEach(function(col) {
                    var tgt = col === 'speed' ? speedCell : delayCell; if (!tgt) return;
                    var s = 0;
                    for (i = 0; i < cells.length; i++) { if (cells[i].classList.contains('highlighted') && cellCol(cells[i]) === col) s += parseInt(cells[i].textContent) || 0; }
                    tgt.textContent = String(s);
                });
            }
            function doReset() {
                if (input) input.value = '0';
                for (i = 0; i < cells.length; i++) { cells[i].classList.remove('highlighted'); cells[i].innerHTML = cells[i].dataset.initial; }
                if (speedCell) speedCell.textContent = '0';
                if (delayCell) delayCell.textContent = '0';
            }
            if (cb) cb.addEventListener('change', function(){ refresh(cb.checked); });
            if (input) input.addEventListener('input', applyDiscount);
            if (resetBtn) resetBtn.addEventListener('click', doReset);
            for (i = 0; i < cells.length; i++) {
                (function(cell) {
                    cell.style.userSelect = 'none';
                    cell.addEventListener('mousedown', function(e) { if (!cb || !cb.checked) return; e.preventDefault(); toggleCell(cell); });
                })(cells[i]);
            }
        });
    });<\/script>`;
    bodyEndScripts.push(calcLogicScript);

    const paintsLogicScript = `<script>document.addEventListener('DOMContentLoaded', function() {
        var paintEls = document.querySelectorAll('.rarity-cont .paint');
        if (!paintEls.length) return;
        var info = document.getElementById('paint_info');
        if (!info) { info = document.createElement('div'); info.id = 'paint_info'; info.className = 'position-absolute d-none'; document.body.appendChild(info); }
        var filtersWrapper = document.querySelector('.paint-filters-wrapper');
        var searchInput = filtersWrapper ? filtersWrapper.querySelector('#paint-search-input') : null;
        if (searchInput) searchInput.addEventListener('input', function(e){ searchPaints(e.target.value); });
        for (var i = 0; i < paintEls.length; i++) {
            (function(paint){
                paint.addEventListener('mousemove', function(event) {
                    var desc = paint.querySelector('.paint-description');
                    if (desc) { info.innerHTML = ''; info.appendChild(desc.cloneNode(true)); info.classList.remove('d-none');
                        info.style.left = (event.pageX + 15) + 'px'; info.style.top = (event.pageY + 15) + 'px'; }
                });
                paint.addEventListener('mouseleave', function(){ info.classList.add('d-none'); });
            })(paintEls[i]);
        }
        document.querySelectorAll('.paint-filter').forEach(function(f) {
            f.addEventListener('click', function(){
                filterPaints(f.getAttribute('data-filter'));
                document.querySelectorAll('.paint-filter').forEach(function(x){ x.classList.remove('paint-filter-active'); });
                f.classList.add('paint-filter-active');
            });
        });
        function searchPaints(name) {
            var lower = (name || '').toLowerCase();
            for (var i = 0; i < paintEls.length; i++) {
                var pn = (paintEls[i].querySelector('.paint-name') ? paintEls[i].querySelector('.paint-name').textContent : '').toLowerCase();
                paintEls[i].style.display = (lower.length <= 2 || pn.indexOf(lower) !== -1) ? 'flex' : 'none';
            }
        }
        function filterPaints(category) {
            for (var i = 0; i < paintEls.length; i++) {
                var r = paintEls[i].getAttribute('data-rarity');
                paintEls[i].style.display = (category === 'All' || r === category) ? 'flex' : 'none';
            }
        }
    });<\/script>`;
    bodyEndScripts.push(paintsLogicScript);

    // 运行时去重兜底：若某控件仍被重复注入，只保留第一个（已翻译的中文控件）
    const dedupInjectedUiScript = `<script>document.addEventListener('DOMContentLoaded', function() {
        document.querySelectorAll('.item-upgrades-block').forEach(function(block) {
            var modes = block.querySelectorAll('.calc-mode');
            for (var i = modes.length - 1; i >= 1; i--) modes[i].remove();
        });
        document.querySelectorAll('.paint-filters-wrapper').forEach(function(w) {
            var s = w.querySelectorAll('.paint-search');
            for (var i = s.length - 1; i >= 1; i--) s[i].remove();
        });
    });<\/script>`;
    bodyEndScripts.push(dedupInjectedUiScript);
    
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

        const batchDiffRecords = new Array();
        for (const preparedData of pendingPreparedPages) {
            const pageName = preparedData.pageNameToProcess;
            const pageResults = pageTranslatedResultsMap[pageName] || {};
            try {
                finalizePage(preparedData, pageResults);
                if (preparedData.currentEditInfo) {
                    // ⚠️ 顺序：先拿旧修订号记账，再覆盖状态记录，否则 diff 的两端会变成同一个版本
                    const prevRevision = lastEditInfo[pageName] || null;
                    const newRevision = preparedData.currentEditInfo;
                    const record = rememberPageRevisionChange(pageName, prevRevision, newRevision, runMode);
                    if (record) batchDiffRecords.push(record);
                    lastEditInfo[pageName] = newRevision;
                }
            } catch (err) {
                console.error(`保存页面出错[${pageName}]:`, err);
            }
        }

        // 每批翻译落盘后立刻写进度，避免中途超时/崩溃丢失已完成页面
        try {
            fs.writeFileSync(EDIT_INFO_FILE, JSON.stringify(lastEditInfo, null, 2), 'utf-8');
            console.log(`💾 已即时保存进度到 last_edit_info.json（当前 ${Object.keys(lastEditInfo).length} 条）`);
        } catch (e) {
            console.warn(`⚠️ 即时保存 last_edit_info.json 失败: ${e.message}`);
        }

        // 【新增】只要有页面更新，就整体覆盖 diff_links.md（BATCH 模式只写本批，RUN 模式写本次进程累计）
        if (batchDiffRecords.length > 0) {
            writeDiffLinksFile(
                DIFF_LINKS_SCOPE === 'BATCH' ? batchDiffRecords : Array.from(runDiffRecords.values()),
                runMode
            );
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

// 仅用于测试/调试：直接 `node translate.js` 时仍会正常执行 run()
module.exports = { rememberPageRevisionChange, writeDiffLinksFile, runDiffRecords, DIFF_LINKS_FILE };

run().catch(console.error);
