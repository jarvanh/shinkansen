//
//  SafariWebExtensionHandler.swift
//  Shinkansen Extension
//
//  Created by Jimmy Su on 2026/6/5.
//

import SafariServices
import os.log

// App Group：與 host app 共享的 UserDefaults suite（SPEC-PRIVATE §26.12）。
// 此 handler 跑在 appex（extension 程序），讀得到 host app（主程序）寫進同一 App Group 的值。
private let appGroupID = "group.app.shinkansen.ios"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@", String(describing: message))

        // background.js 的 pullHostSettings 會送 { action: "pullHostSettings" }；
        // 回傳 host app 寫進 App Group 的設定。其餘訊息維持 echo（沿用預設行為）。
        var payload: [String: Any]
        if let dict = message as? [String: Any],
           let action = dict["action"] as? String,
           action == "pullHostSettings" {
            payload = readHostSettings()
        } else {
            payload = ["echo": message as Any]
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: payload ]
        } else {
            response.userInfo = [ "message": payload ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    // 讀 App Group 共享 UserDefaults 內 host app 寫的設定。
    // seq 一律回（即使 0，代表 host 還沒存過）；apiKey / model 有才回。
    private func readHostSettings() -> [String: Any] {
        guard let defaults = UserDefaults(suiteName: appGroupID) else {
            return ["seq": 0]
        }
        var out: [String: Any] = ["seq": defaults.integer(forKey: "hostSettingsSeq")]
        if let apiKey = defaults.string(forKey: "hostApiKey") {
            out["apiKey"] = apiKey
        }
        if let model = defaults.string(forKey: "hostModel") {
            out["model"] = model
        }
        return out
    }

}
