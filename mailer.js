// 源站出现「新的 diff 值」时，把这批改动通过 QQ 邮箱 SMTP 发出去。
//
// 判定依据（见 diff_check.js）：Feed 里每条改动都带 diff=<修订号>（如 diff=304330），全站单调递增。
// last_diff_check.json 记着上次检测时的最大 diff 值（水位线），本次 Feed 里比它大的就是新改动。
// 与「本次翻译了哪些页面」无关：文件上传、模板这些不翻译的条目，一样会进通知。
// 重定向页不进通知（translate.js 在调用前已剔除），本模块只负责渲染与发送。
//
// 环境变量（全部可选，缺任一必填项就静默跳过，绝不影响主流程）：
//   MAIL_NOTIFY          ON=强制开启 / OFF=关闭 / AUTO=配齐凭据才发（默认 AUTO）
//   MAIL_HOST           默认 smtp.qq.com
//   MAIL_PORT           默认 465（QQ 的 SSL 端口；587 走 STARTTLS 时设 MAIL_SECURE=false）
//   MAIL_SECURE         true/false，默认随端口：465→true，其余→false
//   MAIL_USER           发件邮箱完整地址，如 123456@qq.com
//   MAIL_PASS           QQ 邮箱的【授权码】（不是登录密码）
//   MAIL_TO             收件人，多个用英文逗号分隔
//   MAIL_CC             抄送，可选
//   MAIL_FROM           显示用发件人，默认同 MAIL_USER
//   MAIL_SUBJECT_PREFIX 默认 [3D坦克Wiki]
//   MAIL_DRY_RUN        1/true = 只渲染不真发（用 nodemailer 的 jsonTransport），用于本地调试

const fs = require('fs');
const { buildSitePageUrl, buildSourcePageUrl, buildDiffUrl } = require('./diff_links.js');

function readMailConfig() {
    const port = parseInt(process.env.MAIL_PORT || '465', 10);
    return {
        notify: (process.env.MAIL_NOTIFY || 'AUTO').toUpperCase(),
        host: process.env.MAIL_HOST || 'smtp.qq.com',
        port: isNaN(port) ? 465 : port,
        secure: (process.env.MAIL_SECURE || (port === 465 ? 'true' : 'false')).toLowerCase() === 'true',
        user: (process.env.MAIL_USER || '').trim(),
        pass: (process.env.MAIL_PASS || '').trim(),
        to: (process.env.MAIL_TO || '').trim(),
        cc: (process.env.MAIL_CC || '').trim(),
        from: (process.env.MAIL_FROM || process.env.MAIL_USER || '').trim(),
        subjectPrefix: process.env.MAIL_SUBJECT_PREFIX || '[3D坦克 Wiki]',
        dryRun: ['1', 'true', 'yes', 'on'].includes((process.env.MAIL_DRY_RUN || '').toLowerCase())
    };
}

function splitAddresses(value) {
    return value.split(',').map(s => s.trim()).filter(Boolean);
}

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function localTimeText(date) {
    try {
        return (date ? new Date(date) : new Date()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    } catch (e) {
        return (date ? new Date(date) : new Date()).toISOString();
    }
}

// Feed 里的 <updated>（UTC）→ 北京时间短格式「10-22 21:44」；解析失败就原样返回
function shortTimeText(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
        return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return d.toISOString();
    }
}

// 条目分类（由 translate.js 按命名空间打上）→ 文案 / 配色
const KIND_META = {
    page: { text: '页面', color: '#1a73e8', bg: '#e8f0fe' },
    template: { text: '模板', color: '#b7791f', bg: '#fdf6e7' },
    file: { text: '文件', color: '#2f855a', bg: '#e6f4ea' },
    other: { text: '其它', color: '#627d98', bg: '#eef2f6' }
};
const KIND_ORDER = ['page', 'template', 'file', 'other'];

function kindMeta(kind) {
    return KIND_META[kind] || KIND_META.other;
}

// 「3 页面 · 1 模板 · 6 文件」这类分类计数文案（按固定顺序，只列非零项）
function kindSummaryText(entries) {
    const counts = {};
    for (const e of entries) counts[e.kind] = (counts[e.kind] || 0) + 1;
    return KIND_ORDER.filter(k => counts[k]).map(k => `${counts[k]} ${kindMeta(k).text}`).join(' · ');
}

function revisionText(entry) {
    return entry.oldid ? `${entry.oldid} → ${entry.diff}` : `（新建）${entry.diff}`;
}

// 水位线变化文案：「diff 304323 → 304336」；首次检测没有旧值时写「首次检测 · diff → 304336」
function watermarkText(opts) {
    const from = opts.lastDiff > 0 ? String(opts.lastDiff) : '';
    const to = opts.maxDiff ? String(opts.maxDiff) : '?';
    return from ? `diff ${from} → ${to}` : `首次检测 · diff → ${to}`;
}

// 标题栏：改动数 + 分类计数 + 水位线变化，一眼看出「源站动了什么、动到哪个 diff 了」
function buildSubject(entries, cfg, opts) {
    const o = opts || {};
    const summary = kindSummaryText(entries);
    return `${cfg.subjectPrefix} 源站 ${entries.length} 处新改动${summary ? `：${summary}` : ''}（${watermarkText(o)} · ${o.runMode || 'FEED'}）`;
}

function buildRows(entries) {
    return entries.map(e => {
        const meta = kindMeta(e.kind);
        const diffUrl = buildDiffUrl(e.title, e.diff, e.oldid);         // 上次检测时的版本 → 本次最新
        const curUrl = buildDiffUrl(e.title, 'cur', e.diff);            // 本次最新 → 源站当前（邮件发出后又改了什么）
        const siteCell = e.kind === 'page'
            ? `<a href="${buildSitePageUrl(e.title)}" style="color:#1a73e8;">打开</a>`
            : '<span style="color:#9fb3c8;">—</span>';
        const byline = [e.author ? `作者 ${escapeHtml(e.author)}` : '', e.updated ? shortTimeText(e.updated) : ''].filter(Boolean).join(' · ');
        return `      <tr>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;white-space:nowrap;"><b>${escapeHtml(revisionText(e))}</b>${e.edits > 1 ? `<br><span style="color:#829ab1;font-size:12px;">共 ${e.edits} 次改动</span>` : ''}</td>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;">${escapeHtml(e.title)}${byline ? `<br><span style="color:#829ab1;font-size:12px;">${byline}</span>` : ''}${e.comment ? `<br><span style="color:#486581;font-size:12px;">摘要：${escapeHtml(e.comment)}</span>` : ''}</td>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;white-space:nowrap;"><span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;color:${meta.color};background:${meta.bg};">${meta.text}</span></td>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;white-space:nowrap;"><a href="${diffUrl}" style="color:#1a73e8;">${e.oldid ? '查看 diff' : '查看该版本'}</a>　<a href="${curUrl}" style="color:#999;">对比最新</a>　<a href="${buildSourcePageUrl(e.title)}" style="color:#999;">源站页面</a></td>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;white-space:nowrap;">${siteCell}</td>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;font-size:13px;">${escapeHtml(e.status || '')}</td>
      </tr>`;
    }).join('\n');
}

function buildMailHtml(entries, cfg, opts) {
    const o = opts || {};
    const intro = o.lastDiff > 0
        ? `上次检测记录的最新 diff 为 <b>${escapeHtml(o.lastDiff)}</b>；本次源站 Feed 里有 <b>${entries.length}</b> 个页面出现了更新的 diff 值，最新已到 <b>${escapeHtml(o.maxDiff)}</b>。`
        : `这是首次检测（尚未记录过 diff 水位线），以下为源站 Feed 中带有 diff 值的全部改动（<b>${entries.length}</b> 个页面），最新 diff 为 <b>${escapeHtml(o.maxDiff)}</b>；此后只会通知比它更新的改动。`;

    return `<div style="font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#243b53;line-height:1.7;">
  <h2 style="margin:0 0 12px;font-size:18px;">3D 坦克中文 Wiki · 源站更新通知</h2>
  <p style="margin:0 0 6px;color:#486581;">${intro}</p>
  <p style="margin:0 0 6px;color:#486581;">运行模式 <b>${escapeHtml(o.runMode || 'FEED')}</b>，检测时间 ${escapeHtml(localTimeText())}。</p>
  <p style="margin:0 0 16px;color:#829ab1;font-size:12px;">「查看 diff」= 上次检测时的版本 → 该页最新；「对比最新」= 该版本 → 源站当前（看邮件发出后是否又有改动）。同一页面在两次检测之间的多次改动已合并为一行。</p>
  <table style="border-collapse:collapse;font-size:14px;width:100%;max-width:1000px;">
    <thead>
      <tr style="background:#f0f4f8;">
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">修订号</th>
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">页面</th>
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">类型</th>
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">源站</th>
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">中文站</th>
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">本次处理</th>
      </tr>
    </thead>
    <tbody>
${buildRows(entries)}
    </tbody>
  </table>
  <p style="margin:16px 0 0;color:#486581;font-size:13px;">「本次处理」说明：页面会被重新翻译并部署到中文站；模板只记录修订号（引用它的中文页面内容已过期，需要时用 SPECIFIED 模式重翻）；文件与其它非内容页不处理，仅通知。重定向页不列入通知。</p>${o.hasAttachment ? `
  <p style="margin:6px 0 0;color:#486581;font-size:13px;">附件 <code>diff_links.md</code> 为本次实际翻译 / 记账的页面清单。</p>` : ''}
  <p style="margin:18px 0 0;font-size:12px;color:#829ab1;">本邮件由 GitHub Actions 中的 translate.js 自动发送，直接回复无效。</p>
</div>`;
}

function buildMailText(entries, cfg, opts) {
    const o = opts || {};
    const lines = new Array();
    lines.push(`3D 坦克中文 Wiki · 源站更新通知`);
    lines.push(o.lastDiff > 0
        ? `上次检测的最新 diff：${o.lastDiff}；本次 ${entries.length} 个页面出现更新的 diff 值，最新 diff：${o.maxDiff}`
        : `首次检测（尚无 diff 水位线）：以下为 Feed 中带 diff 值的全部改动（${entries.length} 个页面），最新 diff：${o.maxDiff}`);
    lines.push(`运行模式 ${o.runMode || 'FEED'} · 检测时间 ${localTimeText()}`);
    lines.push('');

    entries.forEach((e, i) => {
        const byline = [e.author ? `作者 ${e.author}` : '', e.updated ? shortTimeText(e.updated) : ''].filter(Boolean).join(' · ');
        lines.push(`${i + 1}. ${e.title}  [${kindMeta(e.kind).text}]  ${revisionText(e)}${e.edits > 1 ? `（共 ${e.edits} 次改动）` : ''}`);
        if (byline) lines.push(`   ${byline}`);
        if (e.comment) lines.push(`   摘要：${e.comment}`);
        lines.push(`   源站 diff：${buildDiffUrl(e.title, e.diff, e.oldid)}`);
        lines.push(`   对比最新：${buildDiffUrl(e.title, 'cur', e.diff)}`);
        if (e.kind === 'page') lines.push(`   中文站：${buildSitePageUrl(e.title)}`);
        if (e.status) lines.push(`   本次处理：${e.status}`);
        lines.push('');
    });

    lines.push('「查看 diff」= 上次检测时的版本 → 该页最新；「对比最新」= 该版本 → 源站当前。');
    if (o.hasAttachment) lines.push('附件 diff_links.md 为本次实际翻译 / 记账的页面清单。');
    return lines.join('\n');
}

/**
 * 发送「源站有新 diff 值」通知邮件。任何失败都只返回结果对象，不抛异常、不中断流水线。
 * @param {object} options {
 *   entries:  diff_check.findNewDiffEntries() 的结果（可附带 status 字段 = 本次处理说明）
 *   lastDiff: 上次检测记录的最新 diff（0 = 首次）
 *   maxDiff:  本次 Feed 里的最大 diff（水位线将推进到的值）
 *   filePath: 可选，diff_links.md 路径（只在本次真的翻译过页面时传入，否则附件会是旧的）
 *   runMode:  FEED / CRAWLER / SPECIFIED
 * }
 * 返回：{ sent:true, … } / { sent:false, skipped:true, reason }（无需发送）/ { sent:false, failed:true, reason }（发送失败）
 */
async function sendNewDiffMail(options) {
    const opts = options || {};
    const cfg = readMailConfig();
    // 🛡️ 彻底排除重定向页（防御性设计：确保不论外部如何传参，重定向页绝不进入邮件通知）
    const entries = (opts.entries || [])
        .filter(e => e && !e.redirect && !e.isRedirect)
        .slice()
        .sort((a, b) => b.diff - a.diff);

    if (cfg.notify === 'OFF') return { sent: false, skipped: true, reason: 'MAIL_NOTIFY=OFF，已关闭邮件通知' };
    if (entries.length === 0) return { sent: false, skipped: true, reason: '没有需要通知的改动（源站无新 diff 值，或新改动均为重定向页），无需发送' };
    if (!cfg.user || !cfg.pass || !cfg.to) {
        return { sent: false, skipped: true, reason: '缺少 MAIL_USER / MAIL_PASS / MAIL_TO，跳过邮件通知' };
    }

    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch (error) {
        return { sent: false, failed: true, reason: `nodemailer 未安装（npm install），无法发送邮件通知: ${error.message}` };
    }

    const transportOptions = cfg.dryRun
        ? { jsonTransport: true }
        : {
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
            auth: { user: cfg.user, pass: cfg.pass },
            // QQ 的 SMTP 偶尔握手很慢，给足超时；失败由下面的重试兜底
            connectionTimeout: 20000,
            greetingTimeout: 20000,
            socketTimeout: 30000,
            tls: { minVersion: 'TLSv1.2' }
        };
    const transporter = nodemailer.createTransport(transportOptions);

    const attachments = (opts.filePath && fs.existsSync(opts.filePath))
        ? [{ filename: 'diff_links.md', path: opts.filePath }]
        : [];
    const renderOpts = {
        lastDiff: Number(opts.lastDiff) || 0,
        maxDiff: Number(opts.maxDiff) || entries[0].diff,
        runMode: opts.runMode,
        hasAttachment: attachments.length > 0
    };
    const subject = buildSubject(entries, cfg, renderOpts);

    const mail = {
        from: cfg.from || cfg.user,
        to: splitAddresses(cfg.to),
        subject,
        text: buildMailText(entries, cfg, renderOpts),
        html: buildMailHtml(entries, cfg, renderOpts),
        attachments
    };
    if (cfg.cc) mail.cc = splitAddresses(cfg.cc);

    const maxAttempts = cfg.dryRun ? 1 : 3;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const info = await transporter.sendMail(mail);
            return {
                sent: true,
                subject,
                messageId: info && info.messageId,
                // jsonTransport 不会回填 accepted，dry-run 时直接回显配置的收件人
                accepted: (info && info.accepted) || (cfg.dryRun ? splitAddresses(cfg.to) : undefined),
                dryRun: cfg.dryRun,
                attachments: attachments.length,
                count: entries.length,
                maxDiff: renderOpts.maxDiff,
                // dry-run 时把渲染结果带回来，方便调试/测试断言
                raw: cfg.dryRun && info && info.message ? info.message : undefined
            };
        } catch (error) {
            lastError = error;
            console.warn(`[邮件通知] 第 ${attempt}/${maxAttempts} 次发送失败: ${error.message}`);
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 10000 * attempt));
        }
    }
    return { sent: false, failed: true, reason: `邮件发送失败: ${lastError && lastError.message}` };
}

module.exports = { sendNewDiffMail, readMailConfig, buildMailHtml, buildMailText, buildSubject };
