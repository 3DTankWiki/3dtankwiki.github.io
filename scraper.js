const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');

// --- 配置 ---
const BASE_URL = 'https://en.tankiwiki.com';
const OUTPUT_DIR = path.join(__dirname, 'public');
// 在这里添加所有你想要搬运的页面路径
const PAGES_TO_SCRAPE = [
    '/Tanki_Online_Wiki', // 主页
    '/Help',
    '/Frequently_Asked_Questions',
    '/Tech_Support',
    '/Game_mechanics',
    '/Guides',
    // ... 在这里添加更多页面路径
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
            font-family: sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 2rem;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
            background-color: rgba(0, 38, 59, 0.8); /* 半透明深色背景 */
            border-radius: 8px;
            box-shadow: 0 0 15px rgba(118, 255, 51, 0.1);
        }
        a {
            color: #76FF33;
            text-decoration: none;
        }
        a:hover {
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
        }
        .dablink, .printfooter, .catlinks, #siteSub, #contentSub, .mw-indicators {
            display: none; /* 隐藏不需要的维基元素 */
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
    // 确保URL是绝对路径
    const fullUrl = assetUrl.startsWith('http') ? assetUrl : `${BASE_URL}${assetUrl}`;
    
    // 从URL中解析出文件路径
    const urlObject = new URL(fullUrl);
    const relativePath = urlObject.pathname;
    const outputPath = path.join(OUTPUT_DIR, relativePath);

    // 检查文件是否已存在
    if (await fs.pathExists(outputPath)) {
        console.log(`- Asset already exists: ${relativePath}`);
        return;
    }

    try {
        console.log(`- Downloading asset: ${fullUrl}`);
        // 确保目录存在
        await fs.ensureDir(path.dirname(outputPath));

        // 发起请求并以流的形式保存文件
        const response = await axios({
            method: 'GET',
            url: fullUrl,
            responseType: 'stream',
        });

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

        // 提取标题和核心内容区域
        const title = $('#firstHeading').text();
        const $content = $('#mw-content-text');

        // 如果没有找到核心内容，则跳过
        if (!$content.length) {
            console.warn(`-- Could not find content for ${pagePath}. Skipping.`);
            return;
        }
        
        const assetsToDownload = [];

        // 1. 处理图片
        $content.find('img').each((i, el) => {
            const $img = $(el);
            let src = $img.attr('src');
            if (src) {
                // 处理懒加载的图片
                const dataSrc = $img.attr('data-src');
                if(dataSrc) src = dataSrc;

                assetsToDownload.push(src);
                // 确保路径是相对于根目录的，以便在任何深度的页面上都能正确引用
                $img.attr('src', src.startsWith('/') ? src : new URL(src).pathname);
            }
        });

        // 2. 处理链接
        $content.find('a').each((i, el) => {
            const $a = $(el);
            let href = $a.attr('href');
            if (href && href.startsWith('/') && !href.startsWith('//')) {
                // 如果是维基内部链接，则将其指向 .html 文件
                // 排除指向文件的链接
                if (!href.match(/\.\w+$/)) {
                    // 去除查询参数和哈希
                    const urlParts = href.split(/[?#]/);
                    const cleanPath = urlParts[0];
                    $a.attr('href', `${cleanPath}.html` + (urlParts.length > 1 ? `#${urlParts.slice(1).join('#')}` : ''));
                }
            }
        });
        
        // 并发下载所有资源
        await Promise.all(assetsToDownload.map(url => downloadAsset(url)));

        // 组合最终的HTML内容
        const finalContent = `
            <h1 id="firstHeading">${title}</h1>
            ${$content.html()}
        `;
        
        // 生成最终的HTML文件
        const outputHtml = createHtmlTemplate(title, finalContent);
        
        // 决定输出文件名
        let outputFileName = pagePath === '/Tanki_Online_Wiki' ? 'index.html' : `${pagePath}.html`;
        const outputFilePath = path.join(OUTPUT_DIR, outputFileName);
        
        // 确保目录存在
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
    // 清理并创建输出目录
    await fs.emptyDir(OUTPUT_DIR);
    console.log(`Output directory '${OUTPUT_DIR}' cleaned.`);

    // 循环抓取所有页面
    for (const page of PAGES_TO_SCRAPE) {
        await scrapePage(page);
    }

    console.log('Scraping finished!');
}

main();
