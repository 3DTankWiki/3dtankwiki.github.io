// 引入必要的库
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { renderDiffLinksMarkdown } = require('./diff_links.js');
const { sendNewDiffMail } = require('./mailer.js');
const { readDiffCheck, writeDiffCheck, findNewDiffEntries, maxDiffOf } = require('./diff_check.js');

// --- 【配置常量】 ---
// 🇷🇺 源站：俄语版 Tanki Online Wiki
const BASE_URL = 'https://ru.tankiwiki.com';
const RECENT_CHANGES_FEED_URL = `${BASE_URL}/api.php?action=feedrecentchanges&days=7&feedformat=atom&urlversion=1`;
const EDIT_INFO_FILE = path.join(__dirname, 'last_edit_info.json');

// 源站双端 diff 链接清单：写在 main 分支根目录，每次有页面/模板版本更新时整体覆盖
const DIFF_LINKS_FILE = path.join(__dirname, 'diff_links.md');

// 源站「最新 diff 水位线」：记录上次监测时 Feed 里最大的 diff=<修订号>（如 304330）。
// 每次运行都把 Feed 里的 diff 值和它比：有更大的 → 说明源站有新改动 → 发邮件，并把水位线推到新的最大值。
// 例外：重定向页不列入通知，但它们的 diff 值照样推进水位线。
const DIFF_CHECK_FILE = path.join(__dirname, 'last_diff_check.json');

// 页面名一律使用「解码后的西里尔原文」形式（如 Устройства），
// 若传入的是百分号编码，这里自动解码，避免出现两套键名
const sanitizePageName = (name) => {
    if (!name) return name;
    if (/%[0-9A-Fa-f]{2}/.test(name)) {
        try { name = decodeURIComponent(name); } catch (e) { /* 非法编码则保持原样 */ }
    }
    return name.replaceAll(' ', '_');
};

// 需要屏蔽的非内容命名空间（俄站链接里英文规范名和俄语本地化名两种写法都可能出现）
const NS_BLOCKLIST = new Array(
    'Special', 'File', 'Image', 'User', 'MediaWiki', 'Template', 'Help', 'Category', 'Talk',
    'Служебная', 'Файл', 'Изображение', 'Участник', 'Участница', 'Шаблон',
    'Справка', 'Категория', 'Обсуждение', 'Обсуждение_участника', 'Обсуждение_участницы',
    'Обсуждение_файла', 'Обсуждение_шаблона', 'Обсуждение_категории', 'МедиаВики'
);

// 是否属于模板命名空间（俄站同时存在 Шаблон: 与 Template: 两种写法）
const isTemplateName = (title) => /^(Шаблон|Template|模板):/i.test(String(title || ''));

// 其它命名空间（文件/用户/讨论…）不记入 last_edit_info.json / diff_links.md（仍可触发邮件通知）
const isBlockedNamespace = (title) => NS_BLOCKLIST.some(p => String(title).startsWith(p + ':'));

// 文件命名空间（俄站同时存在 Файл: / Изображение: 与 File: / Image: 写法）
const isFileName = (title) => /^(Файл|Изображение|File|Image):/i.test(String(title || ''));

// Feed 条目分类（只影响通知里的展示与「本次记录」说明）：
//   page = 普通页面 / template = 模板 / file = 文件 / other = 用户页、分类等
function classifyTitle(title) {
    if (isTemplateName(title)) return 'template';
    if (isFileName(title)) return 'file';
    if (isBlockedNamespace(title)) return 'other';
    return 'page';
}

// Feed 用 decodeEntities:false 解析，文本里的 XML 实体要自己还原
function decodeXmlEntities(text) {
    return String(text == null ? '' : text)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Feed 的 <summary>（已还原实体的 HTML）第一段 <p>
function firstSummaryParagraph(summaryHtml) {
    const match = String(summaryHtml || '').match(/<p>([\s\S]*?)<\/p>/);
    const html = match ? match[1] : '';
    const text = html ? cheerio.load(`<p>${html}</p>`)('p').text().replace(/\s+/g, ' ').trim() : '';
    return { html, text };
}

// 编辑摘要（只做展示用）：第一段是系统日志句时视为无摘要；解析失败一律返回空串
function extractEditComment(summaryHtml) {
    try {
        const { html, text } = firstSummaryParagraph(summaryHtml);
        if (!text || /mw-userlink/.test(html)) return '';
        return text.length > 120 ? `${text.slice(0, 117)}…` : text;
    } catch (e) {
        return '';
    }
}

// 从 Feed 的 <summary> 判定该条改动是否属于重定向页（邮件通知与版本记录排除此类页面）
function detectRedirect(summaryHtml) {
    try {
        if (!summaryHtml) return null;

        // 1. 正文 / diff / 摘要中出现显式的重定向指令语法
        const contentMatch = summaryHtml.match(/(?:^|[^a-zA-Z0-9\u0400-\u04FF])#\s*(?:redirect|перенаправление|перенапр|редирект)[^\[]*\[\[([^\]|#]*)/iu);
        if (contentMatch) {
            const target = contentMatch[1].trim();
            return { reason: 'content', target: target ? sanitizePageName(target) : null };
        }
        if (/(?:^|[^a-zA-Z0-9\u0400-\u04FF])#\s*(?:redirect|перенаправление|перенапр|редирект)/iu.test(summaryHtml)) {
            return { reason: 'content', target: null };
        }

        // 2. 检查摘要文本中的 MediaWiki 日志与自动摘要
        const text = summaryHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        // 页面重命名（旧标题自动成为重定向）
        if (/переименовала?\s+страницу|moved page/iu.test(text)) {
            const lastLinkTitle = (summaryHtml.match(/<a\b[^>]*\btitle="([^"]*)"[^>]*>(?![\s\S]*<a\b)/i) || [])[1] || '';
            return { reason: 'move', target: lastLinkTitle ? sanitizePageName(lastLinkTitle) : null };
        }

        // 自动摘要或编辑备注中的重定向关键字
        const summaryMatch = text.match(/(?:Перенаправление на|Redirected page to|Редирект на|Перенаправление в)\s+\[?\[?([^\]]+?)\]?\]?(?:\s|$)/iu);
        if (summaryMatch) {
            const target = summaryMatch[1].trim();
            return { reason: 'summary', target: target ? sanitizePageName(target) : null };
        }

        if (/(?:^|[^\w\u0400-\u04FF])(?:Перенаправление|Redirected page|Редирект)\b/iu.test(text)) {
            return { reason: 'summary', target: null };
        }

        // 3. MediaWiki 专有 HTML 标识
        if (/class=["\x27][^"\x27]*\bmw-redirect\b|redirect=no/i.test(summaryHtml)) {
            return { reason: 'mw_redirect_tag', target: null };
        }

        return null;
    } catch (e) {
        return null;
    }
}

// 重定向原因 → 日志文案
function redirectReasonText(redirect) {
    const reasons = {
        summary: '新建重定向',
        move: '页面重命名，旧标题已成重定向',
        content: '正文为 #REDIRECT',
        mw_redirect_tag: '标记为重定向'
    };
    const base = reasons[redirect && redirect.reason] || '重定向页';
    return redirect && redirect.target ? `${base} → ${redirect.target}` : base;
}

// 把 Feed 响应（原始 Atom XML，或 Chrome XML 查看器包装后的 HTML）解析成条目数组
function parseRecentChangesFeed(responseText) {
    const $html = cheerio.load(responseText || '');
    const xmlContainer = $html('#webkit-xml-viewer-source-xml');
    let feedXml = xmlContainer.length ? xmlContainer.html() : (responseText || '');
    feedXml = feedXml.replace(/xmlns="[^"]*"/g, '');

    const $ = cheerio.load(feedXml, { xmlMode: true, decodeEntities: false });
    const entries = new Array();
    $('entry').each((i, entry) => {
        const $entry = $(entry);
        const title = sanitizePageName($entry.find('title').first().text());
        let alternateLink = null;
        $entry.find('link').each(function() {
            if ($(this).attr('rel') === 'alternate') { alternateLink = $(this).attr('href'); return false; }
        });
        if (!title || !alternateLink) return;

        const diffMatch = alternateLink.match(/diff=(\d+)/);
        const oldMatch = alternateLink.match(/oldid=(\d+)/);
        const summaryHtml = decodeXmlEntities($entry.find('summary').first().text());
        entries.push({
            title,
            kind: classifyTitle(title),
            diff: diffMatch ? parseInt(diffMatch[1], 10) : null,
            oldid: oldMatch ? parseInt(oldMatch[1], 10) : 0,
            updated: $entry.find('updated').first().text().trim() || null,
            author: decodeXmlEntities($entry.find('author name').first().text()).trim() || null,
            comment: extractEditComment(summaryHtml),
            redirect: detectRedirect(summaryHtml),
            link: decodeXmlEntities(alternateLink)
        });
    });
    return entries;
}

// 用 Puppeteer 拉取源站 Feed（源站有 JS Cookie 校验，裸 HTTP 请求拿不到正文）。
// 成功返回条目数组（可能为空）；失败返回 null（= 本次没检测成，水位线原地不动）。
async function fetchRecentChangesFeed() {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: new Array('--no-sandbox', '--disable-setuid-sandbox') });
        const page = await browser.newPage();
        await page.goto(RECENT_CHANGES_FEED_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        return parseRecentChangesFeed(await page.content());
    } catch (error) {
        console.error('❌ 获取源站 Feed 失败:', error.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

// === 页面与模板版本记录 → last_edit_info.json + diff_links.md ===
const runDiffRecords = new Map();

function rememberPageRevisionChange(pageName, oldRev, newRev, kind) {
    if (!newRev) return null;
    if (String(newRev) === String(oldRev || '')) return null;
    const record = {
        page: pageName,
        oldRev: oldRev ? String(oldRev) : null,
        newRev: String(newRev),
        type: oldRev ? 'update' : 'new',
        kind: kind || 'page',
        at: new Date().toISOString()
    };
    runDiffRecords.set(pageName, record);
    return record;
}

// 用当前运行收集到的记录【整体覆盖】diff_links.md（不追加历史）
function writeDiffLinksFile(records) {
    if (!records || records.length === 0) return;
    try {
        const markdown = renderDiffLinksMarkdown(records, {
            generatedAt: new Date().toISOString()
        });
        fs.writeFileSync(DIFF_LINKS_FILE, markdown, 'utf-8');
        console.log(`🔗 已写入源站 diff 链接清单 -> ${path.basename(DIFF_LINKS_FILE)}（${records.length} 条，整体覆盖）`);
    } catch (error) {
        console.warn(`⚠️ 写入 ${path.basename(DIFF_LINKS_FILE)} 失败: ${error.message}`);
    }
}

// 从 Feed 里挑出「修订号比 last_edit_info.json 记录更新」的页面与模板（跳过重定向与其它屏蔽命名空间）
function collectRevisionUpdates(entries, lastEditInfo) {
    const records = new Array();
    if (!Array.isArray(entries) || entries.length === 0) return records;

    // 同一条目在 Feed 里可能出现多次：取最大 diff 作为最新修订号，取最小 diff 的 oldid 作为首次前序版本
    const byTitle = new Map();
    for (const entry of entries) {
        if (!entry || !entry.title || !entry.diff) continue;
        const existing = byTitle.get(entry.title);
        if (!existing) {
            byTitle.set(entry.title, {
                revision: entry.diff,
                firstDiff: entry.diff,
                previousRevision: entry.oldid || 0,
                redirect: entry.redirect || null
            });
            continue;
        }
        if (entry.diff > existing.revision) {
            existing.revision = entry.diff;
            existing.redirect = entry.redirect || null;
        }
        if (entry.diff < existing.firstDiff) {
            existing.firstDiff = entry.diff;
            existing.previousRevision = entry.oldid || 0;
        }
    }

    for (const [title, info] of byTitle.entries()) {
        if (info.redirect) continue; // 重定向页不记入页面版本与 diff 清单
        const isTemplate = isTemplateName(title);
        if (!isTemplate && isBlockedNamespace(title)) continue;

        const currentRevisionId = Number(lastEditInfo[title] || 0);
        if (info.revision <= currentRevisionId) continue;

        const prevRevision = currentRevisionId > 0 ? currentRevisionId : (info.previousRevision || null);
        const kind = isTemplate ? 'template' : 'page';
        const record = rememberPageRevisionChange(title, prevRevision, info.revision, kind);
        if (record) records.push(record);

        lastEditInfo[title] = info.revision;
        console.log(`${isTemplate ? '🧩 [模板]' : '📄 [页面]'} ${title}：修订号 ${prevRevision || '（首次记录）'} → ${info.revision}`);
    }
    return records;
}

// === 源站「新 diff 值」检测 → 邮件通知 ===
function splitRedirectEntries(entries) {
    const notify = new Array();
    const redirects = new Array();
    for (const entry of entries || []) {
        if (!entry) continue;
        if (entry.redirect) {
            redirects.push(entry);
        } else {
            notify.push(entry);
        }
    }
    return { notify, redirects };
}

function detectNewDiffs(feedEntries) {
    const state = readDiffCheck(DIFF_CHECK_FILE);
    const result = {
        checked: false,
        firstRun: !(state.lastDiff > 0),
        lastDiff: state.lastDiff,
        maxDiff: state.lastDiff,
        maxDiffTitle: state.lastDiffTitle,
        newEntries: new Array()
    };
    if (!Array.isArray(feedEntries)) {
        console.log(`🔎 [diff 检测] 本次未取得源站 Feed，跳过监测（水位线保持 ${state.lastDiff || '未建立'}）`);
        return result;
    }

    result.checked = true;
    result.newEntries = findNewDiffEntries(feedEntries, state.lastDiff);
    const top = maxDiffOf(feedEntries);
    if (top && top.diff > state.lastDiff) {
        result.maxDiff = top.diff;
        result.maxDiffTitle = top.title;
    }

    if (result.newEntries.length > 0) {
        const { notify, redirects } = splitRedirectEntries(result.newEntries);
        console.log(`🔎 [diff 检测] 水位线 ${state.lastDiff || '（未建立，首次监测）'} → Feed 最新 diff ${result.maxDiff}：共 ${result.newEntries.length} 处新改动（${notify.length} 处待通知，已排除 ${redirects.length} 个重定向页）`);
        for (const e of notify) {
            console.log(`   · [通知] ${e.title} [${e.kind}] ${e.oldid ? `${e.oldid} → ${e.diff}` : `（新建）${e.diff}`}${e.edits > 1 ? `（共 ${e.edits} 次改动）` : ''}`);
        }
        for (const e of redirects) {
            console.log(`   · [重定向排除] ${e.title}（${redirectReasonText(e.redirect)}）`);
        }
    } else {
        console.log(`🔎 [diff 检测] Feed 里没有比水位线 ${state.lastDiff} 更新的 diff 值，源站无新改动。`);
    }
    return result;
}

function saveDiffCheck(diffCheck) {
    if (!diffCheck || !diffCheck.checked || !(diffCheck.maxDiff > diffCheck.lastDiff)) return false;
    try {
        writeDiffCheck(DIFF_CHECK_FILE, { lastDiff: diffCheck.maxDiff, lastDiffTitle: diffCheck.maxDiffTitle });
        console.log(`💾 已更新 diff 水位线 -> ${path.basename(DIFF_CHECK_FILE)}：${diffCheck.lastDiff || '（无）'} → ${diffCheck.maxDiff}（${diffCheck.maxDiffTitle}）`);
        return true;
    } catch (error) {
        console.warn(`⚠️ 写入 ${path.basename(DIFF_CHECK_FILE)} 失败: ${error.message}`);
        return false;
    }
}

// 通知里的「本次记录」一列
function describeEntryHandling(entry, lastEditInfo) {
    switch (entry.kind) {
        case 'template': {
            const record = runDiffRecords.get(entry.title);
            if (record) return record.oldRev ? '✅ 已记录模板新版本' : '✅ 已新增模板版本记录';
            return '已是最新模板记录';
        }
        case 'file': return '不记录版本（文件，仅通知）';
        case 'other': return '不记录版本（非内容页，仅通知）';
        default: {
            const record = runDiffRecords.get(entry.title);
            if (record) return record.oldRev ? '✅ 已记录新版本' : '✅ 已新增版本记录';
            if (Number(lastEditInfo[entry.title] || 0) >= entry.diff) return '已是最新记录';
            return '未记录';
        }
    }
}

async function run() {
    console.log("--- 3D 坦克 Wiki 变更监测开始 ---");

    let lastEditInfo = {};
    if (fs.existsSync(EDIT_INFO_FILE)) {
        try { lastEditInfo = JSON.parse(fs.readFileSync(EDIT_INFO_FILE, 'utf-8')); } catch (e) {}
    }

    console.log(`正在从 ${RECENT_CHANGES_FEED_URL} 获取最近变更...`);
    const feedEntries = await fetchRecentChangesFeed();

    // 1. 更新页面与模板版本记录（last_edit_info.json + diff_links.md）
    const versionRecords = collectRevisionUpdates(feedEntries, lastEditInfo);
    if (versionRecords.length > 0) {
        try {
            fs.writeFileSync(EDIT_INFO_FILE, JSON.stringify(lastEditInfo, null, 2), 'utf-8');
            console.log(`💾 已保存页面与模板版本记录 -> ${path.basename(EDIT_INFO_FILE)}（共 ${Object.keys(lastEditInfo).length} 条，本次更新 ${versionRecords.length} 条）`);
        } catch (e) {
            console.warn(`⚠️ 写入 ${path.basename(EDIT_INFO_FILE)} 失败: ${e.message}`);
        }
        writeDiffLinksFile(Array.from(runDiffRecords.values()));
    }

    // 2. 检测新 diff 水位线并发送邮件通知
    const diffCheck = detectNewDiffs(feedEntries);
    if (versionRecords.length === 0 && diffCheck.newEntries.length === 0) {
        return console.log("没有新的页面版本或 diff 改动，本次监测结束。");
    }

    const { notify: notifyEntries, redirects: redirectEntries } = splitRedirectEntries(diffCheck.newEntries);
    if (redirectEntries.length > 0) {
        console.log(`🔇 已从通知中剔除 ${redirectEntries.length} 个重定向页：${redirectEntries.map(e => `${e.title}（${redirectReasonText(e.redirect)}）`).join('、')}`);
    }

    let mailResult = { sent: false, skipped: true, reason: '未执行' };
    try {
        mailResult = await sendNewDiffMail({
            entries: notifyEntries.map(e => ({ ...e, status: describeEntryHandling(e, lastEditInfo) })),
            lastDiff: diffCheck.lastDiff,
            maxDiff: diffCheck.maxDiff,
            filePath: runDiffRecords.size > 0 ? DIFF_LINKS_FILE : null
        });
        if (mailResult.sent) {
            console.log(`📧 邮件通知已发送：${mailResult.subject}${mailResult.dryRun ? '（dry-run，未真正投递）' : ''}`);
        } else {
            console.log(`📭 未发送邮件通知：${mailResult.reason}`);
        }
    } catch (error) {
        mailResult = { sent: false, failed: true, reason: error.message };
        console.warn(`⚠️ 邮件通知异常（已忽略）: ${error.message}`);
    }

    if (mailResult.failed) {
        console.log(`⏸️ 邮件发送失败，diff 水位线保持 ${diffCheck.lastDiff || '未建立'}，下次监测将重新通知这批改动。`);
    } else if (mailResult.dryRun) {
        console.log(`⏸️ dry-run 模式，不推进 diff 水位线（保持 ${diffCheck.lastDiff || '未建立'}）。`);
    } else {
        saveDiffCheck(diffCheck);
    }

    console.log("--- 变更监测任务安全结束！ ---");
}

module.exports = {
    rememberPageRevisionChange,
    writeDiffLinksFile,
    runDiffRecords,
    DIFF_LINKS_FILE,
    isTemplateName,
    collectRevisionUpdates,
    DIFF_CHECK_FILE,
    classifyTitle,
    parseRecentChangesFeed,
    fetchRecentChangesFeed,
    detectNewDiffs,
    saveDiffCheck,
    detectRedirect,
    splitRedirectEntries,
    describeEntryHandling
};

if (require.main === module) {
    run().catch(console.error);
}
