// 页面更新后，把 diff_links.md 的内容通过 QQ 邮箱 SMTP 发出去。
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
const { buildSitePageUrl, buildDiffUrl } = require('./diff_links.js');

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

function localTimeText() {
    try {
        return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    } catch (e) {
        return new Date().toISOString();
    }
}

// 排序：修订号大的在前，其次按页面名
function sortRecords(records) {
    return (records || []).slice().sort((a, b) =>
        String(b.newRev).localeCompare(String(a.newRev)) || String(a.page).localeCompare(String(b.page)));
}

function buildSubject(records, cfg, runMode) {
    return `${cfg.subjectPrefix} ${records.length} 个页面已更新（${runMode || 'FEED'} · ${localTimeText()}）`;
}

function buildMailHtml(records, cfg, runMode) {
    const list = sortRecords(records);
    const rows = list.map(r => {
        const diffUrl = buildDiffUrl(r.page, r.newRev, r.oldRev);
        const curUrl = buildDiffUrl(r.page, 'cur', r.newRev); // 翻译完之后源站又改了什么
        const revText = r.oldRev ? `${escapeHtml(r.oldRev)} → ${escapeHtml(r.newRev)}` : `（新增）${escapeHtml(r.newRev)}`;
        return `      <tr>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;">${escapeHtml(r.page)}</td>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;"><a href="${buildSitePageUrl(r.page)}" style="color:#1a73e8;">打开</a></td>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;"><a href="${diffUrl}" style="color:#1a73e8;">${r.oldRev ? '查看 diff' : '查看该版本'}</a>　<a href="${curUrl}" style="color:#999;">对比最新</a></td>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;">${revText}</td>
        <td style="padding:8px 10px;border:1px solid #d9e2ec;">${r.oldRev ? '更新' : '新增'}</td>
      </tr>`;
    }).join('\n');

    return `<div style="font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#243b53;line-height:1.7;">
  <h2 style="margin:0 0 12px;font-size:18px;">3D 坦克中文 Wiki · 页面更新通知</h2>
  <p style="margin:0 0 6px;color:#486581;">本次共 <b>${list.length}</b> 个页面发生变化，运行模式 <b>${escapeHtml(runMode || 'FEED')}</b>，生成时间 ${escapeHtml(localTimeText())}。</p>
  <p style="margin:0 0 16px;color:#486581;">下表「查看 diff」为源站 <b>上一版 → 本次</b> 的双端对比；「对比最新」可看翻译完之后源站是否又有改动。完整清单见附件 <code>diff_links.md</code>。</p>
  <table style="border-collapse:collapse;font-size:14px;width:100%;max-width:900px;">
    <thead>
      <tr style="background:#f0f4f8;">
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">页面</th>
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">中文站</th>
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">源站 diff</th>
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">修订号</th>
        <th style="padding:8px 10px;border:1px solid #d9e2ec;text-align:left;">类型</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p style="margin:18px 0 0;font-size:12px;color:#829ab1;">本邮件由 GitHub Actions 中的 translate.js 自动发送，直接回复无效。</p>
</div>`;
}

function buildMailText(records, cfg, runMode) {
    const list = sortRecords(records);
    const lines = new Array();
    lines.push(`3D 坦克中文 Wiki · 页面更新通知`);
    lines.push(`本次更新 ${list.length} 个页面 · 运行模式 ${runMode || 'FEED'} · 生成时间 ${localTimeText()}`);
    lines.push('');
    list.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.page}  [${r.oldRev ? '更新' : '新增'}]`);
        lines.push(`   中文站：${buildSitePageUrl(r.page)}`);
        lines.push(`   源站 diff：${buildDiffUrl(r.page, r.newRev, r.oldRev)}`);
        lines.push(`   修订号：${r.oldRev ? `${r.oldRev} → ${r.newRev}` : `（新增）${r.newRev}`}`);
        lines.push('');
    });
    lines.push('完整清单见附件 diff_links.md。');
    return lines.join('\n');
}

/**
 * 发送更新通知邮件。任何失败都只返回 { sent:false, reason }，不抛异常、不中断流水线。
 * @param {object} options { records, filePath, runMode }
 */
async function sendDiffLinksMail(options) {
    const opts = options || {};
    const cfg = readMailConfig();
    const records = sortRecords(opts.records);

    if (cfg.notify === 'OFF') return { sent: false, reason: 'MAIL_NOTIFY=OFF，已关闭邮件通知' };
    if (records.length === 0) return { sent: false, reason: '本次运行没有页面更新，无需发送' };
    if (!cfg.user || !cfg.pass || !cfg.to) {
        return { sent: false, reason: '缺少 MAIL_USER / MAIL_PASS / MAIL_TO，跳过邮件通知' };
    }

    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch (error) {
        return { sent: false, reason: `nodemailer 未安装（npm install），跳过邮件通知: ${error.message}` };
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

    const subject = buildSubject(records, cfg, opts.runMode);
    const attachments = (opts.filePath && fs.existsSync(opts.filePath))
        ? [{ filename: 'diff_links.md', path: opts.filePath }]
        : [];

    const mail = {
        from: cfg.from || cfg.user,
        to: splitAddresses(cfg.to),
        subject,
        text: buildMailText(records, cfg, opts.runMode),
        html: buildMailHtml(records, cfg, opts.runMode),
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
                // dry-run 时把渲染结果带回来，方便调试/测试断言
                raw: cfg.dryRun && info && info.message ? info.message : undefined
            };
        } catch (error) {
            lastError = error;
            console.warn(`[邮件通知] 第 ${attempt}/${maxAttempts} 次发送失败: ${error.message}`);
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 10000 * attempt));
        }
    }
    return { sent: false, reason: `邮件发送失败: ${lastError && lastError.message}` };
}

module.exports = { sendDiffLinksMail, readMailConfig, buildMailHtml, buildMailText };
