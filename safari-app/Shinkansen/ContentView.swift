// 主畫面:icon / 標題 / 副標 / 一段說明 / 兩個 button / footer 連結
// 對外字串透過 Localizable.xcstrings 提供,英文 / 繁中由 macOS 系統語言自動切換

import SwiftUI
import SafariServices

private let extensionBundleIdentifier = "app.shinkansen.macos.Extension"

private let repoURL = URL(string: "https://github.com/jimmysu0309/shinkansen")!
private let apiKeyGuideURL = URL(string: "https://github.com/jimmysu0309/shinkansen/blob/main/docs/API-KEY-SETUP.md")!
private let privacyPolicyURL = URL(string: "https://jimmysu0309.github.io/shinkansen/privacy-policy.html")!

struct ContentView: View {
    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    var body: some View {
        VStack(spacing: 24) {
            header
            Divider().padding(.horizontal, 40)
            description
            buttons
            Spacer()
            footer
        }
        .padding(.vertical, 32)
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(NSColor.windowBackgroundColor))
    }

    private var header: some View {
        VStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage ?? NSImage())
                .resizable()
                .interpolation(.high)
                .frame(width: 96, height: 96)
            Text("Shinkansen")
                .font(.system(size: 28, weight: .semibold))
            Text("subtitle")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    private var description: some View {
        Text("intro")
            .font(.body)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var buttons: some View {
        VStack(spacing: 12) {
            Button {
                openExtensionPreferences()
            } label: {
                Label("open_safari_settings", systemImage: "gear")
                    .frame(maxWidth: 280)
            }
            .controlSize(.large)
            .buttonStyle(.borderedProminent)

            Button {
                NSWorkspace.shared.open(apiKeyGuideURL)
            } label: {
                Label("open_api_key_guide", systemImage: "key")
                    .frame(maxWidth: 280)
            }
            .controlSize(.large)
            .buttonStyle(.bordered)
        }
    }

    private var footer: some View {
        HStack(spacing: 16) {
            Link("privacy_policy", destination: privacyPolicyURL)
            Text(verbatim: "·").foregroundStyle(.tertiary)
            Link("GitHub", destination: repoURL)
            Text(verbatim: "·").foregroundStyle(.tertiary)
            Text(verbatim: "v\(appVersion)").foregroundStyle(.secondary)
        }
        .font(.footnote)
        .padding(.bottom, 8)
    }

    private func openExtensionPreferences() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            if let error {
                NSLog("[Shinkansen] showPreferencesForExtension failed: \(error.localizedDescription)")
            }
        }
    }
}

#Preview {
    ContentView()
}
