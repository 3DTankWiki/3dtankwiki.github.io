const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');

// --- 配置 ---
const BASE_URL = 'https://en.tankiwiki.com';
const OUTPUT_DIR = path.join(__dirname, 'public');

// 在这里添加所有你想要搬运的页面路径
const PAGES_TO_SCRAPE = [
    '/Tanki_Online_Wiki', // 主页 (会被转换为 index.html)
    '/Help',
    '/Frequently_Asked_Questions',
    '/Tech_Support',
    '/Game_mechanics',
    '/Guides',
    '/About_the_game',
    '/How_to_start',
    '/ESports',
    '/Museum',
    '/Community'
    // ... 在这里可以继续添加更多页面路径
];

// HTML 模板，包含了自定义样式
const createHtmlTemplate = (title, content) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - 3D Tanki Wiki Mirror</title>
    <style>
        body {
            background-color: #001926;
            color: #E0E0E0; /* 浅灰色文字，对比度更高 */
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 1rem;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
            background-color: rgba(0, 25, 38, 0.85); /* 半透明深色背景 */
            border-radius: 8px;
            box-shadow: 0 0 20px rgba(118, 255, 51, 0.1);
            border: 1px solid rgba(118, 255, 51, 0.2);
        }
        a {
            color: #76FF33;
            text-decoration: none;
            transition: color 0.2s;
        }
        a:hover {
            color: #B2FF59; /* 悬停时更亮的绿色 */
            text-decoration: underline;
        }
        img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
        }
        h1, h2, h3, h4, h5, h6 {
            color: #FFFFFF;
            border-bottom: 1px solid #76FF33;
            padding-bottom: 0.3em;
            margin-top: 1.5em;
        }
        /* 隐藏原维基页面中不需要的元素 */
        .dablink, .printfooter, .catlinks, #siteSub, #contentSub, .mw-indicators, .mw-editsection, .visualClear, .alert, #custom-report-footer, [align="right"] small {
            display: none;
        }
        /* 优化代码块和引用块样式 */
        pre, blockquote {
            background-color: rgba(0, 0, 0, 0.2);
            padding: 1em;
            border-left: 3px solid #76FF33;
            border-radius: 4px;
            overflow-x: auto;
        }
        code {
            background-color: rgba(0, 0, 0, 0.3);
            padding: 0.2em 0.4em;
            border-radius: 3px;
            font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        ${content}
    </div>
</body>
</html>
`;

// 下载资源（如图片）
async function downloadAsset(assetUrl) {
    const fullUrl = assetUrl.startsWith('http') ? assetUrl : `${BASE_URL}${assetUrl}`;
    const urlObject = new URL(fullUrl);
    const relativePath = urlObject.pathname;
    const outputPath = path.join(OUTPUT_DIR, relativePath);

    if (await fs.pathExists(outputPath)) {
        console.log(`- Asset already exists: ${relativePath}`);
        return;
    }

    try {
        console.log(`- Downloading asset: ${fullUrl}`);
        await fs.ensureDir(path.dirname(outputPath));
        const response = await axios({ method: 'GET', url: fullUrl, responseType: 'stream' });
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        console.error(`-- Error downloading asset ${fullUrl}: ${error.message}`);
    }
}

// 抓取并处理单个页面
async function scrapePage(pagePath) {
    try {
        console.log(`Scraping page: ${pagePath}`);
        const { data: html } = await axios.get(`${BASE_URL}${pagePath}`);
        const $ = cheerio.load(html);

        const title = $('#firstHeading').text().trim();
        const $content = $('#mw-content-text .mw-parser-output'); // 更精确地选择内容区域

        if (!$content.length) {
            console.warn(`-- Could not find content for ${pagePath}. Skipping.`);
            return;
        }
        
        const assetsToDownload = [];

        $content.find('img').each((i, el) => {
            const $img = $(el);
            let src = $img.attr('src');
            if (src) {
                const dataSrc = $img.attr('data-src');
                if (dataSrc) src = dataSrc;
                if (!src.startsWith('http')) src = new URL(src, BASE_URL).href;
                assetsToDownload.push(src);
                const localSrc = new URL(src).pathname;
                $img.attr('src', localSrc);
            }
        });

        $content.find('a').each((i, el) => {
            const $a = $(el);
            let href = $a.attr('href');
            if (href && href.startsWith('/') && !href.startsWith('//')) {
                const [cleanPath, hash] = href.split('#');
                if (!cleanPath.match(/\.(png|jpg|jpeg|gif|svg)$/i)) { // 排除直接指向图片的链接
                    const newHref = cleanPath === '/Tanki_Online_Wiki' ? '/index.html' : `${cleanPath}.html`;
                    $a.attr('href', newHref + (hash ? `#${hash}` : ''));
                }
            }
        });
        
        await Promise.all(assetsToDownload.map(url => downloadAsset(url)));
        
        const finalContent = `<h1 id="firstHeading">${title}</h1>\n${$content.html()}`;
        const outputHtml = createHtmlTemplate(title, finalContent);
        
        let outputFileName = pagePath === '/Tanki_Online_Wiki' ? 'index.html' : `${pagePath}.html`;
        const outputFilePath = path.join(OUTPUT_DIR, outputFileName);
        
        await fs.ensureDir(path.dirname(outputFilePath));
        await fs.writeFile(outputFilePath, outputHtml);
        
        console.log(`- Successfully created: ${outputFilePath}`);

    } catch (error) {
        console.error(`Error scraping ${pagePath}: ${error.message}`);
    }
}

// 主执行函数
async function main() {
    console.log('Starting Tanki Wiki Scraper...');
    await fs.emptyDir(OUTPUT_DIR);
    console.log(`Output directory '${OUTPUT_DIR}' cleaned.`);
    
    // 使用 Promise.all 来并发抓取页面，速度更快
    await Promise.all(PAGES_TO_SCRAPE.map(page => scrapePage(page)));

    console.log('Scraping finished!');
}

main();
