# 內嵌字型授權

Shinkansen 在「翻譯文件 PDF 翻譯」功能(SPEC §17)下載譯文 PDF 時內嵌以下字型，
以下列出來源與授權。

## Noto Sans CJK TC Regular

- **檔案**:`shinkansen/lib/vendor/fonts/NotoSansTC-Regular.otf`
- **來源**:Google Noto CJK Sans 計畫(github.com/notofonts/noto-cjk)
- **授權**:SIL Open Font License Version 1.1
- **授權檔**:`shinkansen/lib/vendor/fonts/LICENSE-NotoSansTC.txt`

譯文 PDF 下載時 pdf-lib 用 `subset: true` 只 embed 譯文實際用到的字元
(通常 100-300KB / 頁)，最終 PDF 內字型 subset 不影響 extension 體積。

## pdf-lib + fontkit

- **檔案**:`shinkansen/lib/vendor/pdf-lib/pdf-lib.min.js`、`fontkit.umd.min.js`
- **來源**:pdf-lib(MIT)、fontkit(MIT)— npm package
- **授權**:MIT License(允許自由整合進任何專案)
