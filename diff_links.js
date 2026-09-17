// 「页面 / 模板状态记录」发生变化时，生成源站的「上一版 → 本次」双端 diff 链接清单。
// 输出文件（main 分支的 diff_links.md）每次有更新时【整体覆盖】，不追加历史记录。
//
// 之所以单独拆成一个文件（而不是塞进 translate.js）：
//   1. translate.js 顶部 require('puppeteer')，无法脱离浏览器环境单独测试；
//   2. 与仓库既有的 translations.js / source_replacements.js 保持一致的「根目录小模块」风格。
//
// 【模板】模板更新也会进入本清单，但只列源站链接、不生成页面。
//        判断依据只是记录里的 kind 字段（translate.js 记账时打上的），本模块不需要知道命名空间规则。

// 中文站（gh-pages）基址，可用环境变量覆盖（例如自定义域名）
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://3dtankwiki.github.io';
// 源站（俄语 Wiki）的 index.php 入口
const SOURCE_INDEX_URL = process.env.SOURCE_INDEX_URL || 'https://ru.tankiwiki.com/index.php';

// 页面名 → URL 片段（保留 / 不转义，其余按 RFC3986 编码）
function encodePageName(pageName) {
    return encodeURIComponent(String(pageName || '')).replace(/%2F/gi, '/');
}

// 中文站页面地址（GitHub Pages 支持无扩展名访问 /PageName → PageName.html）
function buildSitePageUrl(pageName) {
    return `${SITE_BASE_URL}/${encodePageName(pageName)}`;
}

// 源站页面地址（页面、模板通用）
function buildSourcePageUrl(pageName) {
    return `https://ru.tankiwiki.com/${encodePageName(pageName)}`;
}

// 【显式双端 diff 链接】diff = 右侧（较新版本），oldid = 左侧（较旧版本）
//   index.php?title=<页面>&diff=<新修订号>&oldid=<旧修订号>
// 旧修订号直接取自 last_edit_info.json 里「上一次翻译时记录的版本」，
// 因此这个链接永远指向「中文站当前译文所对应的那一次源站改动」，不会随时间漂移。
function buildDiffUrl(pageName, newRev, oldRev) {
    const query = `title=${encodePageName(pageName)}`;
    if (oldRev) return `${SOURCE_INDEX_URL}?${query}&diff=${newRev}&oldid=${oldRev}`;
    // 首次收录的页面没有「上一版」，退化为指向该版本本身
    return `${SOURCE_INDEX_URL}?${query}&oldid=${newRev}`;
}

function escapeCell(text) {
    return String(text == null ? '' : text).replace(/\|/g, '\\|');
}

// 记录是否是模板（kind 由 translate.js 记账时打上；缺省按页面处理，兼容旧记录）
function isTemplateRecord(record) {
    return !!record && record.kind === 'template';
}

// 把一批记录拆成「页面」与「模板」两组（模板不生成页面，展示上要分开）
function splitRecords(records) {
    const pages = new Array();
    const templates = new Array();
    for (const record of records || []) {
        if (!record) continue;
        (isTemplateRecord(record) ? templates : pages).push(record);
    }
    return { pages, templates };
}

// 排序：修订号大的在前，其次按页面名
function sortRecords(records) {
    return (records || []).slice().sort((a, b) =>
        String(b.newRev).localeCompare(String(a.newRev)) || String(a.page).localeCompare(String(b.page)));
}

// 一条记录的类型文案（页面：更新/新增；模板：更新/首次记录）
function typeText(record) {
    const isTemplate = isTemplateRecord(record);
    if (record.oldRev) return isTemplate ? '模板更新' : '更新';
    return isTemplate ? '首次记录' : '新增';
}

function revisionText(record) {
    return record.oldRev
        ? `${escapeCell(record.oldRev)} → ${escapeCell(record.newRev)}`
        : `（新增）${escapeCell(record.newRev)}`;
}

// 记录里可选的人工备注（例如「源站模板页已不存在」）
function noteText(record) {
    return record.note ? ` ⚠️ ${escapeCell(record.note)}` : '';
}

// 把一批更新记录渲染成 Markdown。records 里每条形如：
//   { page, oldRev, newRev, type: 'update' | 'new', kind: 'page' | 'template', mode, at, note? }
function renderDiffLinksMarkdown(records, meta) {
    const info = meta || {};
    const { pages, templates } = splitRecords(sortRecords(records));
    const lines = new Array();

    lines.push('# 最近更新的页面与模板 · 源站双端 Diff');
    lines.push('');
    lines.push('> 本文件由 `translate.js` 自动生成：只要某个页面 / 模板的修订号相对 `last_edit_info.json` 发生变化，');
    lines.push('> 就会把「上一版 → 本次」的 diff 链接写到这里，**每次更新整体覆盖，不追加历史**。请勿手工编辑。');
    lines.push('');
    lines.push(`- 生成时间：${escapeCell(info.generatedAt || new Date().toISOString())}`);
    lines.push(`- 运行模式：${escapeCell(info.runMode || 'FEED')}`);
    if (templates.length > 0) {
        lines.push(`- 本次更新：${pages.length} 个页面 + ${templates.length} 个模板（模板不生成页面，仅记录修订号并发送通知）`);
    } else {
        lines.push(`- 本次更新：${pages.length} 个页面`);
    }
    lines.push('');

    if (pages.length === 0 && templates.length === 0) {
        lines.push('本次运行没有检测到页面或模板更新。');
        lines.push('');
        return lines.join('\n');
    }

    // 只有页面时保持旧版式（不额外加小标题），有模板时才分节展示
    const useSections = templates.length > 0;

    if (pages.length > 0) {
        if (useSections) {
            lines.push(`## 页面（${pages.length}）`);
            lines.push('');
        }
        lines.push('| 页面 | 中文站 | 源站 diff（上一版 → 本次） | 修订号 | 类型 |');
        lines.push('| --- | --- | --- | --- | --- |');
        for (const r of pages) {
            const page = escapeCell(r.page);
            const siteCell = `[打开](${buildSitePageUrl(r.page)})`;
            const diffCell = `[${r.oldRev ? 'diff' : '查看该版本'}](${buildDiffUrl(r.page, r.newRev, r.oldRev)})`;
            lines.push(`| ${page} | ${siteCell} | ${diffCell} | ${revisionText(r)} | ${typeText(r)}${noteText(r)} |`);
        }
        lines.push('');
    }

    if (templates.length > 0) {
        if (useSections) {
            lines.push(`## 模板（${templates.length}，不生成页面）`);
            lines.push('');
        }
        lines.push('| 模板 | 源站模板页 | 源站 diff（上一版 → 本次） | 修订号 | 类型 |');
        lines.push('| --- | --- | --- | --- | --- |');
        for (const r of templates) {
            const template = escapeCell(r.page);
            const sourceCell = `[打开](${buildSourcePageUrl(r.page)})`;
            const diffCell = `[${r.oldRev ? 'diff' : '查看该版本'}](${buildDiffUrl(r.page, r.newRev, r.oldRev)})`;
            lines.push(`| ${template} | ${sourceCell} | ${diffCell} | ${revisionText(r)} | ${typeText(r)}${noteText(r)} |`);
        }
        lines.push('');
        lines.push('> 模板不参与翻译、不落盘（中文站没有独立模板页），只记录修订号并发送通知。');
        lines.push('> 模板「上一版」优先取 `last_edit_info.json` 里记过的版本；首次记录时取 Feed 给出的 `oldid`（即这次改动的前一版）。');
        lines.push('> 模板一变，**引用它的中文页面内容就已经过期**；需要刷新时用 SPECIFIED 模式指定对应页面重新翻译。');
        lines.push('');
    }

    lines.push('> 想看「翻译完之后源站又改了什么」，把上面的 `oldid=` 值取出来拼成：');
    lines.push('> `<源站>/index.php?title=<页面>&diff=cur&oldid=<本次修订号>`');
    lines.push('');
    return lines.join('\n');
}

module.exports = {
    SITE_BASE_URL,
    SOURCE_INDEX_URL,
    encodePageName,
    buildSitePageUrl,
    buildSourcePageUrl,
    buildDiffUrl,
    isTemplateRecord,
    splitRecords,
    sortRecords,
    typeText,
    renderDiffLinksMarkdown
};
