const axios = require('axios');
const cheerio = require('cheerio');
const fs = 'fs-extra';
const path = require('path');

// --- 配置 ---
const BASE_URL = 'https://en.tankiwiki.com';
// 需要搬运的页面列表 (例如: 'Help', 'Crystals', 主页 'Tanki_Online_Wiki')
const PAGES_TO_SCRAPE = ['Tanki_Online_Wiki', 'Help', 'Crystals', 'Gold_Boxes']; 
const OUTPUT_DIR = path.resolve(__dirname, 'dist'); // 输出目录，最终会部署到 GitHub Pages

// --- 主函数 ---
async function runScraper() {
    console.log('🚀 Starting scraper...');
    
    // 读取 HTML 模板
    const template = await fs.readFile(path.resolve(__dirname, 'template.html'), 'utf-8');

    // 清理并创建输出目录
    await fs.emptyDir(OUTPUT_DIR);

    for (const pageName of PAGES_TO_SCRAPE) {
        try {
            console.log(`\n📄 Scraping page: ${pageName}`);
            const pageUrl = `${BASE_URL}/${pageName}`;
            
            // 1. 获取页面 HTML
            const { data: html } = await axios.get(pageUrl);
            const $ = cheerio.load(html);

            // 2. 提取核心内容
            // 维基的主要内容在 #mw-content-text > .mw-parser-output 中
            const contentContainer = $('#mw-content-text .mw-parser-output');
            
            // 移除不需要的末尾部分 (例如 "Retrieved from...", 分类链接等)
            contentContainer.find('.printfooter').remove();
            contentContainer.find('#catlinks').remove();
            
            const pageTitle = $('#firstHeading').text().replace(' - Tanki Online Wiki', '').trim();
            console.log(`   - Title found: ${pageTitle}`);

            // 3. 处理并下载图片
            const imagePromises = [];
            contentContainer.find('img').each((i, img) => {
                const $img = $(img);
                let src = $img.attr('src');
                if (!src) return;

                // 将相对 URL 转换为绝对 URL 以便下载
                const imageUrl = new URL(src, BASE_URL).href;
                
                // 本地保存路径与网站路径保持一致
                const localImagePath = path.join(OUTPUT_DIR, new URL(imageUrl).pathname);

                console.log(`   - Found image: ${imageUrl}`);
                imagePromises.push(downloadImage(imageUrl, localImagePath));
            });
            await Promise.all(imagePromises);
            console.log('   - All images processed.');

            // 4. 修复内部链接
            contentContainer.find('a').each((i, a) => {
                const $a = $(a);
                let href = $a.attr('href');
                if (href && href.startsWith('/')) {
                    // 将 /PageName 转换为 /PageName/ (GitHub Pages 友好)
                    const cleanHref = href.split('#')[0].split('?')[0]; // 去除 hash 和 query
                    if (PAGES_TO_SCRAPE.includes(cleanHref.substring(1))) {
                        $a.attr('href', `${cleanHref}/`);
                    }
                }
            });
            console.log('   - Internal links fixed.');

            // 5. 生成最终 HTML
            const scrapedContent = contentContainer.html();
            let finalHtml = template.replace('{{PAGE_TITLE}}', pageTitle);
            finalHtml = finalHtml.replace('{{PAGE_CONTENT}}', scrapedContent);

            // 6. 保存文件
            // 将 'Tanki_Online_Wiki' 保存为根目录的 index.html
            const isHomePage = pageName === 'Tanki_Online_Wiki';
            const outputFilePath = isHomePage
                ? path.join(OUTPUT_DIR, 'index.html')
                : path.join(OUTPUT_DIR, pageName, 'index.html');

            await fs.ensureDir(path.dirname(outputFilePath));
            await fs.writeFile(outputFilePath, finalHtml);
            console.log(`   - ✔️  Page saved to: ${outputFilePath}`);

        } catch (error) {
            console.error(`❌ Failed to scrape ${pageName}:`, error.message);
        }
    }
    
    console.log('\n✅ Scraper finished successfully!');
}

async function downloadImage(url, localPath) {
    try {
        await fs.ensureDir(path.dirname(localPath));
        const writer = fs.createWriteStream(localPath);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        console.error(`   - ❌ Failed to download image ${url}: ${error.message}`);
    }
}

runScraper();
