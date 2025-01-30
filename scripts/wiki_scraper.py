import os
import time
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from deep_translator import GoogleTranslator
from bs4 import BeautifulSoup, Comment

# 目标页面和存放路径
URL = "https://en.tankiwiki.com/Tanki_Online_Wiki"
OUTPUT_FILE = "Tanki_Online_Wiki.html"  # 生成 HTML 文件

# 初始化翻译器
translator = GoogleTranslator(source="en", target="zh-CN")

# 配置 Selenium WebDriver
options = webdriver.ChromeOptions()
options.add_argument("--headless")  # 无头模式
options.add_argument("--disable-gpu")
options.add_argument("--no-sandbox")
options.add_argument("--disable-software-rasterizer")

# 启动 Selenium WebDriver
driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)

def translate_text(text):
    """使用 Google 翻译文本"""
    if not text or not text.strip():  # 避免空文本
        return text
    try:
        translated = translator.translate(text)
        return translated if translated else text  # 避免返回 None
    except Exception as e:
        print(f"⚠️ 翻译失败: {e}")
        return text  # 翻译失败时，返回原文

def fetch_and_translate(url, output_file):
    """爬取 HTML 并翻译正文部分"""
    print(f"🚀 Fetching {url}...")
    driver.get(url)
    time.sleep(5)  # 等待页面加载完毕

    # 获取完整 HTML 结构
    page_source = driver.page_source  # 获取页面的 HTML 源代码
    print("⏳ 读取网页源代码...")
    print(page_source)  # 打印页面源代码（用于调试）

    soup = BeautifulSoup(page_source, "html.parser")

    # 提取网页的标题并翻译
    original_title = soup.title.string if soup.title else "Tanki Online Wiki"  # 获取原网页的标题
    translated_title = translate_text(original_title)  # 翻译标题

    # 找到 <!-- Title --> 注释
    title_comment = soup.find(string=lambda text: isinstance(text, Comment) and "Title" in text)
    if not title_comment:
        print("❌ 未找到 <!-- Title --> 注释，无法定位开始位置！")
        return

    # 获取从 <!-- Title --> 注释到 </small> 之间的所有内容
    current_element = title_comment.find_next_sibling()
    extracted_html = ""
    while current_element:

        # 添加当前元素
        extracted_html += str(current_element)
        print(f"当前元素: {current_element}")  # 打印当前元素（用于调试）

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

    # 生成完整 HTML 文件，使用翻译后的标题
    final_html = f"""<html>
    <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;700&display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=M+PLUS+1p&display=swap" rel="stylesheet">
        <title>{translated_title}</title>
        <style>
            body {{
                font-family: 'Rubik', 'M PLUS 1p';
                margin: 20px;
                max-width: 900px;
                line-height: 1.6;
                background-color: #001926;  /* 设置背景颜色 */
                color: #ffffff;  /* 设置文字颜色为白色 */
            }}
            h1 {{
                color: #ffffff;  /* 设置标题文字颜色为白色 */
            }}
        </style>
    </head>
    <body>
        {str(content_soup)}
    </body>
    </html>
    """

    # 删除 </small></div> 后面的所有内容
    end_index = final_html.find("</small></div>")  # 查找 </small></div> 的位置

    if end_index != -1:
        final_html = final_html[:end_index + len("</small></div>")]  # 保留到 </small></div> 位置之前的内容

    # 添加 </html> 到文件末尾（确保 </html> 在文件末尾）
    final_html += "</html>"

    # 保存 HTML 文件到根目录
    file_path = os.path.join(os.getcwd(), output_file)  # 保存到当前工作目录（即根目录）

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(final_html)

    print(f"✅ 保存成功: {file_path}")

# 运行爬取和翻译
if __name__ == "__main__":
    fetch_and_translate(URL, OUTPUT_FILE)

# 关闭浏览器
driver.quit()
