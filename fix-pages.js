#!/usr/bin/env node
/**
 * fix-pages.js — 检测并修复已部署页面里的「计算器 / 迷彩搜索 / 随机趣闻」问题。
 *
 * 背景：翻译流水线用 Puppeteer 渲染后，把注入后的中文控件固化进了静态 HTML，
 * 却仍保留了源站的升级/迷彩脚本。用户在浏览器打开时，这些脚本会再次注入控件 →
 * 出现重复的俄语计算器按钮 / 两个迷彩搜索框；且源站 upgradesCalculator.js 依赖
 * 不存在的 .total 元素，勾选时会崩溃并重复加和。
 * 另外，源站的「随机趣闻」框（interestingFact）是固定写死一条内容，并不会真正
 * 从 facts.json 随机读取；本脚本可把这些框改成从站点根目录 facts.json 随机读取。
 *
 * 本脚本直接对 gh-pages 分支上已部署的 .html 做增量修复：
 *   - 检测哪些页面包含：
 *       .item-upgrades-block  （计算器）
 *       .paint-filters-wrapper（迷彩搜索）
 *       .interestingFact      （随机趣闻框，可随机读取 facts.json）
 *   - 剔除源站注入型脚本标签（upgradesCalculator.js / paints.js）
 *   - 注入仓库自托管的「逻辑版」脚本（只绑定功能、不注入；计算器不依赖 .total）
 *   - 注入运行时去重脚本（兜底删除重复控件）
 *   - 把 interestingFact 框内容改为随机读取 facts.json
 *   - 幂等：已修复页面带注释标记，重复运行会跳过
 *
 * 用法：node fix-pages.js --dir=./gh-pages-dir [--dry-run]
 *   --dry-run=true：只检测并报告，不写入。
 * 趣闻修复（把 interestingFact 改为随机读取 facts.json）始终启用。
 * 无第三方依赖，可直接在 GitHub Actions 里运行。
 */

const fs = require('fs');
const path = require('path');

// ---------- 命令行参数 ----------
const args = {};
process.argv.slice(2).forEach(a => {
  const m = a.match(/^--(\w[\w-]*)=(.*)$/) || a.match(/^--(\w[\w-]*)$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
});
const DIR = args.dir || './gh-pages-dir';
const DRY_RUN = args['dry-run'] === 'true' || args['dry-run'] === true;

// ---------- 检测规则：只针对真正有该内容块的页面 ----------
const CALC_CONTENT_RE = /class="[^"]*item-upgrades-block/;
const PAINTS_CONTENT_RE = /class="[^"]*paint-filters-wrapper/;
const FACT_CONTENT_RE = /class="[^"]*interestingFact/;
const CALC_SCRIPT_RE = /skins\/TankiBlue\/resources\/scripts\/upgradesCalculator\.js/;
const PAINTS_SCRIPT_RE = /skins\/TankiBlue\/resources\/scripts\/paints\.js/;
const MARKER = '<!-- wiki-fix-applied -->';

// ---------- 要注入的脚本 ----------
const DEDUP_SCRIPT = `<script>document.addEventListener('DOMContentLoaded', function() {
        document.querySelectorAll('.item-upgrades-block').forEach(function(block) {
            var modes = block.querySelectorAll('.calc-mode');
            for (var i = modes.length - 1; i >= 1; i--) modes[i].remove();
        });
        document.querySelectorAll('.paint-filters-wrapper').forEach(function(w) {
            var s = w.querySelectorAll('.paint-search');
            for (var i = s.length - 1; i >= 1; i--) s[i].remove();
        });
    });</script>`;

const CALC_LOGIC_SCRIPT = `<script>document.addEventListener('DOMContentLoaded', function() {
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
    });</script>`;

const PAINTS_LOGIC_SCRIPT = `<script>document.addEventListener('DOMContentLoaded', function() {
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
    });</script>`;

// 随机趣闻脚本：从站点根目录 facts.json 随机取一条填入每个趣闻框内容区。
// relPrefix 在注入时按页面层级填充（根目录 ./facts.json，子目录 ../facts.json）。
function factsScript(relPrefix) {
  return `<script>document.addEventListener('DOMContentLoaded', function() {
        fetch('${relPrefix}facts.json').then(function(r){ return r.json(); }).then(function(facts) {
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
    });</script>`;
}

// 把 interestingFact 框里的内容 div（带 `font-size: 95%; padding-top:10px` 样式的那一层）
// 整体替换为占位符。源站框结构：
//   <div class="interestingFact" style="...">
//     <div style="font-size:105%;..."> 标题（你知道吗……）</div>
//     <div style="font-size: 95%; padding-top:10px"> <p>固定内容</p> </div>   ← 替换这一层
//   </div>
// 之后由 facts 脚本向该层填入随机趣闻。
function replaceFactContent(html) {
  return html.replace(
    /<div style="font-size:\s*95%;[^"]*padding-top:\s*10px[^"]*">[\s\S]*?<\/div>/i,
    '<div style="font-size: 95%; padding-top:10px"><p style="margin:0;" data-fact-placeholder="true">正在加载有趣的事实...</p></div>'
  );
}

// ---------- 主流程 ----------
function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`目录不存在: ${DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.html'));

  const summary = {
    scanned: files.length,
    calcPages: 0,
    paintPages: 0,
    factPages: 0,
    fixed: [],
    alreadyFixed: 0,
    dryRun: DRY_RUN,
  };

  for (const file of files) {
    const fp = path.join(DIR, file);
    let html;
    try { html = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }

    const hasCalc = CALC_CONTENT_RE.test(html);
    const hasPaints = PAINTS_CONTENT_RE.test(html);
    const hasFact = FACT_CONTENT_RE.test(html);
    // 无关页面跳过：没有任何要处理的块
    if (!hasCalc && !hasPaints && !hasFact) continue;

    if (hasCalc) summary.calcPages++;
    if (hasPaints) summary.paintPages++;
    if (hasFact) summary.factPages++;

    if (html.includes(MARKER)) { summary.alreadyFixed++; continue; }

    // 剔除源站注入型脚本（若存在）
    html = html.replace(/<script[^>]*skins\/TankiBlue\/resources\/scripts\/upgradesCalculator\.js[^>]*><\/script>/gi, '');
    html = html.replace(/<script[^>]*skins\/TankiBlue\/resources\/scripts\/paints\.js[^>]*><\/script>/gi, '');

    // 计算相对前缀（facts.json 在站点根目录）
    const depth = (file.match(/\//g) || []).length;
    const relPrefix = depth === 0 ? './' : '../'.repeat(depth);

    // 注入脚本
    let inject = DEDUP_SCRIPT;
    if (hasCalc) inject += CALC_LOGIC_SCRIPT;
    if (hasPaints) inject += PAINTS_LOGIC_SCRIPT;
    if (hasFact) {
      html = replaceFactContent(html);
      inject += factsScript(relPrefix);
    }
    inject += MARKER;

    // 在 </body> 前插入
    const bodyIdx = html.search(/<\/body>/i);
    if (bodyIdx === -1) continue;
    html = html.slice(0, bodyIdx) + inject + '\n' + html.slice(bodyIdx);

    summary.fixed.push(file);
    if (!DRY_RUN) fs.writeFileSync(fp, html, 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));
  if (DRY_RUN) {
    console.log(`\n[dry-run] 以上 ${summary.fixed.length} 个页面将被修复（未写入）。`);
  } else {
    console.log(`\n修复完成：${summary.fixed.length} 个页面已更新。`);
  }
  // 供 workflow 解析的机器可读行（固定以 FIXED= 开头）
  console.log(`FIXED=${summary.fixed.length}`);
}

main();
