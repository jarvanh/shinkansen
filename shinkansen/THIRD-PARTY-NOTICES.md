# Third-Party Notices

Shinkansen 整合下列第三方軟體與字型，本檔列出來源、授權與授權檔位置。

## JavaScript 套件

### PDF.js

- **用途**：翻譯文件功能解析 PDF / render 頁面 canvas / 抽取 text run
- **檔案**:`shinkansen/lib/vendor/pdfjs/pdf.min.mjs`、`pdf.worker.min.mjs`
- **來源**:Mozilla(github.com/mozilla/pdf.js)
- **授權**:Apache License 2.0
- **授權檔**:`shinkansen/lib/vendor/pdfjs/LICENSE`

### pdf-lib

- **用途**：翻譯文件功能下載「雙頁並排對照 PDF」時用 pdf-lib 創新 PDFDocument、
  copyPages 把原 page embed 進新 doc、addPage 創新譯文頁、page.drawText 畫譯文
- **檔案**:`shinkansen/lib/vendor/pdf-lib/pdf-lib.min.js`
- **來源**:Hopding(github.com/Hopding/pdf-lib)
- **授權**:MIT License
- **授權檔**:`shinkansen/lib/vendor/pdf-lib/LICENSE-pdf-lib.md`

### fontkit (@pdf-lib/fontkit)

- **用途**:pdf-lib 透過 fontkit 解析 OpenType 字型 + 做字型 subset(只 embed
  譯文實際用到的字)
- **檔案**:`shinkansen/lib/vendor/pdf-lib/fontkit.umd.min.js`
- **來源**:Devon Govett 原作 / Hopding fork(npm @pdf-lib/fontkit)
- **授權**:MIT License
- **授權檔**:`shinkansen/lib/vendor/pdf-lib/LICENSE-fontkit`

## 字型

### Noto Sans CJK TC Regular

- **用途**：翻譯文件下載譯文 PDF 時內嵌作為譯文中文字型(中文標點 / 漢字 95%+
  覆蓋率)。pdf-lib subset: true 在最終 PDF 內只 embed 譯文用到的字 subset(典型
  100-300KB)，不影響譯文 PDF 大小
- **檔案**:`shinkansen/lib/vendor/fonts/NotoSansTC-Regular.otf`
- **來源**:Google Noto CJK Sans 計畫(github.com/notofonts/noto-cjk)
- **授權**:SIL Open Font License Version 1.1
- **授權檔**:`shinkansen/lib/vendor/fonts/LICENSE-NotoSansTC.txt`
- **限制**：依 SIL OFL 條款，字型本身不可作為其他產品的行銷名稱
