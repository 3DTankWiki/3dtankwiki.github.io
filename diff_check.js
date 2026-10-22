// 「源站最新 diff 水位线」：邮件通知的判定依据。
//
// 源站 Feed 里每条改动的链接形如 index.php?title=X&diff=304330&oldid=304212，
// 其中 diff=<修订号> 全站单调递增。我们只记一件事：上次检测时见过的最大 diff 值（水位线）。
// 下次只要 Feed 里出现比水位线更大的 diff 值，就说明源站有新改动 → 发邮件，并把水位线推到新的最大值。
//
// 与 last_edit_info.json 的分工：
//   - last_edit_info.json 按页面记修订号，决定「要不要重新翻译某页」；
//   - last_diff_check.json 只记一个全站水位线，决定「要不要发通知」。
//   二者互不干扰：文件上传、用户页这类从不翻译的条目，也会因为 diff 值更新而进入通知。
//   重定向页是例外：由 translate.js 在发件前剔除（条目的 redirect 字段），但 diff 值照样推进水位线。
//
// 单独拆成模块的原因与 diff_links.js 相同：translate.js 顶部 require('puppeteer')，不便脱离浏览器环境测试。

const fs = require('fs');

// 状态文件：{ lastDiff: 304336, lastDiffTitle: '…', updatedAt: ISO 时间 }
// 不存在 / 损坏时 lastDiff = 0，表示尚未建立水位线（首次检测会把 Feed 里的全部条目视为新改动）
function readDiffCheck(filePath) {
    const empty = { lastDiff: 0, lastDiffTitle: null, updatedAt: null, exists: false };
    try {
        if (!filePath || !fs.existsSync(filePath)) return empty;
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const lastDiff = parseInt(data && data.lastDiff, 10);
        if (!Number.isFinite(lastDiff) || lastDiff < 0) return empty;
        return {
            lastDiff,
            lastDiffTitle: (data && data.lastDiffTitle) || null,
            updatedAt: (data && data.updatedAt) || null,
            exists: true
        };
    } catch (error) {
        return empty;
    }
}

// 只在水位线真正前进时写盘，避免每次运行都产生无意义的文件改动 / 提交
function writeDiffCheck(filePath, state) {
    const payload = {
        lastDiff: state.lastDiff,
        lastDiffTitle: state.lastDiffTitle || null,
        updatedAt: state.updatedAt || new Date().toISOString()
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    return payload;
}

// 从一批 Feed 条目里挑出「diff 值比水位线大」的条目，并按标题合并：
//   同一页面在两次检测之间被改了多次时只保留一行，diff 取最新一次，oldid 取这段时间内最早那次的上一版，
//   这样「查看 diff」链接正好覆盖「上次检测之后的全部改动」。
// 返回按 diff 从大到小排序的数组，每项形如：
//   { title, kind, diff, oldid, edits, updated, author, comment, redirect }
// redirect（是否重定向页）以最新一次改动为准：先建重定向再改成正文算正文页，反之算重定向页。
function findNewDiffEntries(entries, lastDiff) {
    const threshold = Number.isFinite(Number(lastDiff)) ? Number(lastDiff) : 0;
    const byTitle = new Map();
    for (const entry of entries || []) {
        if (!entry || !entry.title) continue;
        const diff = Number(entry.diff);
        if (!Number.isFinite(diff) || diff <= 0 || diff <= threshold) continue; // 没有 diff 号的日志类条目 / 不比水位线新 → 忽略

        const oldid = Number(entry.oldid) > 0 ? Number(entry.oldid) : 0;
        const existing = byTitle.get(entry.title);
        if (!existing) {
            byTitle.set(entry.title, {
                title: entry.title,
                kind: entry.kind || 'page',
                diff,
                oldid,
                firstDiff: diff,
                edits: 1,
                updated: entry.updated || null,
                author: entry.author || null,
                authors: entry.author ? [entry.author] : [],
                comment: entry.comment || '',
                commentDiff: entry.comment ? diff : 0,
                redirect: entry.redirect || null
            });
            continue;
        }

        existing.edits += 1;
        if (entry.author && !existing.authors.includes(entry.author)) existing.authors.push(entry.author);
        if (diff > existing.diff) {
            // 更新的一次改动：diff / 时间 / 作者以它为准
            existing.diff = diff;
            existing.updated = entry.updated || existing.updated;
            existing.author = entry.author || existing.author;
            existing.redirect = entry.redirect || null;
        }
        // 摘要取「最新一次非空」的（Feed 条目顺序不保证，按 diff 大小判新旧）
        if (entry.comment && diff > existing.commentDiff) {
            existing.comment = entry.comment;
            existing.commentDiff = diff;
        }
        if (diff < existing.firstDiff) {
            // 更早的一次改动：oldid 以它为准，这样 diff 链接能从「上次检测时的版本」一路比到最新
            existing.firstDiff = diff;
            existing.oldid = oldid;
        }
    }

    return Array.from(byTitle.values())
        .map(item => {
            const { firstDiff, commentDiff, authors, ...rest } = item;
            return { ...rest, author: authors.length > 1 ? authors.join('、') : (rest.author || null) };
        })
        .sort((a, b) => b.diff - a.diff || String(a.title).localeCompare(String(b.title)));
}

// 一批 Feed 条目里最大的 diff 值及其标题（没有任何带 diff 号的条目时返回 null）
function maxDiffOf(entries) {
    let best = null;
    for (const entry of entries || []) {
        const diff = Number(entry && entry.diff);
        if (!Number.isFinite(diff) || diff <= 0) continue;
        if (!best || diff > best.diff) best = { diff, title: entry.title };
    }
    return best;
}

module.exports = { readDiffCheck, writeDiffCheck, findNewDiffEntries, maxDiffOf };
