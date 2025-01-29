import os
import time
from bs4 import BeautifulSoup, Comment
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from googletrans import Translator

# 配置 Chrome 驱动程序
def setup_driver():
    """设置并返回 Selenium WebDriver"""
    chrome_options = Options()
    chrome_options.add_argument("--headless")  # 隐藏浏览器窗口
    driver = webdriver.Chrome(options=chrome_options)
    return driver

# 翻译文本
def translate_text(text):
    """翻译文本"""
    translator = Translator()
    try:
        translated = translator.translate(text, src="en", dest="zh-cn")
        return translated.text
    except Exception as e:
        print(f"翻译失败: {e}")
        return None

# 从网页抓取并翻译
def fetch_and_translate(url, output_file):
    """爬取 HTML 并翻译正文部分"""
    print(f"🚀 Fetching {url}...")
    driver = setup_driver()
    driver.get(url)
    time.sleep(5)  # 等待页面加载完毕

    # 获取完整 HTML 结构
    page_source = driver.page_source  # 获取页面的 HTML 源代码
    print("⏳ 读取网页源代码...")
    # 打印部分 HTML 供调试用
    print(page_source[:1000])  # 只打印前 1000 个字符来检查是否正常获取

    # 查找从 "Title" 注释开始的部分
    soup = BeautifulSoup(page_source, "html.parser")

    # 找到 <!-- Title --> 注释
    comment = soup.find(string=lambda text: isinstance(text, Comment) and "Title" in text)
    if not comment:
        print("❌ 未找到 <!-- Title --> 注释，无法定位开始位置！")
        return

    # 获取从注释节点开始的下一个兄弟节点
    current_element = comment.find_next_sibling()

    # 提取从注释开始到 "NewPP" 出现之前的所有内容
    extracted_html = ""
    while current_element:
        # 判断当前元素的文本内容是否包含 "NewPP"
        if "NewPP" in str(current_element):
            break  # 遇到包含 "NewPP" 的文本，停止抓取

        # 添加当前元素
        extracted_html += str(current_element)

        # 获取下一个兄弟节点
        current_element = current_element.find_next_sibling()  # 只查找同级

    # 打印提取的 HTML 结构
    print("提取的 HTML 内容:")
    print(extracted_html)

    # 解析提取的 HTML 结构
    content_soup = BeautifulSoup(extracted_html, "html.parser")

    # 翻译正文内容
    for tag in content_soup.find_all(string=True):
        if tag.parent.name not in ["script", "style", "meta", "link"]:  # 跳过非正文内容
            translated_text = translate_text(tag.string)
            if translated_text is not None:  # 避免 None 造成错误
                tag.replace_with(translated_text)

    # 生成完整 HTML 文件（包含 head）
    final_html = f"""
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Tanki Online Wiki - 中文翻译</title>
        <style>
            body {{
                font-family: Arial, sans-serif;
                margin: 20px;
                max-width: 900px;
                line-height: 1.6;
            }}
            h1 {{
                color: #333;
            }}
        </style>
    </head>
    <body>
        {str(content_soup)}
    </body>
    </html>
    """

    # 保存 HTML 文件到根目录
    file_path = os.path.join(os.getcwd(), output_file)  # 保存到当前工作目录（即根目录）

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(final_html)

    print(f"✅ 保存成功: {file_path}")

    # 关闭浏览器
    driver.quit()

# 使用示例
url = "https://en.tankiwiki.com/index.php?title=Tanki_Online_Wiki&oldid=62502"  # 替换为目标网页的 URL
output_file = "translated_page.html"  # 生成的 HTML 文件名称
fetch_and_translate(url, output_file)
