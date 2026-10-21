#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '.');
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`目录不存在或不是目录：${root}`);
    process.exit(1);
}

const anchorPattern = /<a\b[^>]*>/gi;
const classAttributePattern = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const hrefAttributePattern = /(?:^|\s)(href\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/i;

let filesScanned = 0;
let filesChanged = 0;
let homeButtonsFound = 0;
let linksChanged = 0;
let buttonsWithoutHref = 0;

function patchHtml(html) {
    let pageLinksChanged = 0;
    let pageButtonsFound = 0;
    let pageButtonsWithoutHref = 0;

    const patched = html.replace(anchorPattern, (tag) => {
        const classMatch = tag.match(classAttributePattern);
        if (!classMatch) return tag;

        const classValue = classMatch[1] ?? classMatch[2] ?? classMatch[3] ?? '';
        if (!classValue.split(/\s+/).includes('home-back-btn')) return tag;

        pageButtonsFound++;
        const hrefMatch = tag.match(hrefAttributePattern);
        if (!hrefMatch) {
            pageButtonsWithoutHref++;
            return tag;
        }

        const currentHref = hrefMatch[3] ?? hrefMatch[4] ?? hrefMatch[5] ?? '';
        if (currentHref === '/') return tag;

        const quote = hrefMatch[2].startsWith('"')
            ? '"'
            : hrefMatch[2].startsWith("'") ? "'" : '"';
        const replacement = `${hrefMatch[1]}${quote}/${quote}`;
        pageLinksChanged++;

        return tag.slice(0, hrefMatch.index)
            + hrefMatch[0].slice(0, hrefMatch[0].indexOf(hrefMatch[1]))
            + replacement
            + tag.slice(hrefMatch.index + hrefMatch[0].length);
    });

    return { html: patched, pageLinksChanged, pageButtonsFound, pageButtonsWithoutHref };
}

function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            visit(fullPath);
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.html') {
            filesScanned++;
            const original = fs.readFileSync(fullPath, 'utf8');
            const result = patchHtml(original);
            homeButtonsFound += result.pageButtonsFound;
            buttonsWithoutHref += result.pageButtonsWithoutHref;
            linksChanged += result.pageLinksChanged;

            if (result.html !== original) {
                fs.writeFileSync(fullPath, result.html, 'utf8');
                filesChanged++;
            }
        }
    }
}

visit(root);
console.log(`扫描 HTML：${filesScanned} 个；找到返回主页按钮：${homeButtonsFound} 个；修复链接：${linksChanged} 个；修改文件：${filesChanged} 个。`);
if (buttonsWithoutHref > 0) {
    console.warn(`警告：${buttonsWithoutHref} 个返回主页按钮没有 href 属性，未作修改。`);
}
