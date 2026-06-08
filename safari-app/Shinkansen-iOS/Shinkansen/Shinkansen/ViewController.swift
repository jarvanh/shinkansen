//
//  ViewController.swift
//  Shinkansen
//
//  Created by Jimmy Su on 2026/6/5.
//

import UIKit
import WebKit

class ViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        // 說明頁內容較長（啟用步驟 + 連結），允許捲動，避免小螢幕被裁切。
        self.webView.scrollView.isScrollEnabled = true

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    // 外部 http(s) 連結（API Key 教學 / 隱私權 / 主頁 / 版本紀錄）改用系統 Safari 開啟，
    // 不在 host WKWebView 內導覽，避免使用者點完卡在 GitHub 等外部頁回不到說明畫面。
    // 初始 Main.html 是 file:// → scheme 非 http(s) → 照常允許載入。
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Override point for customization.
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Override point for customization.
    }

}
