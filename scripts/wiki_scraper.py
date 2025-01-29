import os
import time
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from deep_translator import GoogleTranslator
from bs4 import BeautifulSoup

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
    soup = BeautifulSoup(driver.page_source, "html.parser")

    # 找到 <div class="col-12 my-4">
    container = soup.find("div", class_="col-12 my-4")
    if not container:
        print("❌ 未找到 <div class='col-12 my-4'>，请检查页面结构！")
        return

    # 找到 <h1 class="firstHeading">
    first_heading = container.find("h1", class_="firstHeading")
    if not first_heading:
        print("❌ 未找到 <h1 class='firstHeading'>")
        return

    # 提取从 <h1> 到 <div align="right"><small> 之间的所有内容
    extracted_html = ""
    current_element = first_heading

    while current_element:
        extracted_html += str(current_element)

        # 停止条件：找到 <div align="right"><small>
        if current_element.name == "div" and current_element.get("align") == "right":
            small_tag = current_element.find("small")
            if small_tag:
                extracted_html += str(small_tag)
                break  # 找到 <small> 直接退出循环

        current_element = current_element.find_next_sibling()  # 只查找同级，不跨层级

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

# 运行爬取和翻译
if __name__ == "__main__":
    fetch_and_translate(URL, OUTPUT_FILE)

# 关闭浏览器
driver.quit()
