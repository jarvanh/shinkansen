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

    // App Group：與 Safari extension（appex）共享的 UserDefaults suite。
    // host app 把 onboarding / 設定畫面選的 API Key + 預設模型寫進這裡，extension 的
    // background.js 經 native messaging 拉走（見 Shinkansen Extension/SafariWebExtensionHandler.swift）。
    // SPEC-PRIVATE §26.12。
    private let appGroupID = "group.app.shinkansen.ios"
    private var sharedDefaults: UserDefaults? { UserDefaults(suiteName: appGroupID) }

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
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        switch action {
        case "saveSettings":
            saveSettings(body)
        case "getSettings":
            sendSettingsToPage()
        default:
            break
        }
    }

    // 把 onboarding / 設定畫面選的 API Key + 預設模型寫進 App Group，並遞增 seq
    // （extension 端用 seq > consumedSeq 判斷有沒有新設定要套用）。
    private func saveSettings(_ body: [String: Any]) {
        guard let defaults = sharedDefaults else { return }
        if let apiKey = body["apiKey"] as? String {
            defaults.set(apiKey, forKey: "hostApiKey")
        }
        if let model = body["model"] as? String,
           ["flash", "lite", "google"].contains(model) {
            defaults.set(model, forKey: "hostModel")
        }
        let seq = defaults.integer(forKey: "hostSettingsSeq") + 1
        defaults.set(seq, forKey: "hostSettingsSeq")
    }

    // 設定畫面開啟時回填現值（host 直接讀自己寫進 App Group 的值；不反向讀 extension）。
    private func sendSettingsToPage() {
        guard let defaults = sharedDefaults else { return }
        let apiKey = defaults.string(forKey: "hostApiKey") ?? ""
        let model = defaults.string(forKey: "hostModel") ?? ""
        let js = "window.__skApplySettings && window.__skApplySettings(\(jsStringLiteral(apiKey)), \(jsStringLiteral(model)))"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // 把任意字串安全包成 JS 字串字面值（用 JSON 編碼處理引號 / 反斜線 / 換行，
    // 避免 evaluateJavaScript 注入或語法破壞）。
    private func jsStringLiteral(_ s: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [s]),
           let arr = String(data: data, encoding: .utf8) {
            return String(arr.dropFirst().dropLast())   // ["..."] → "..."
        }
        return "\"\""
    }

}
