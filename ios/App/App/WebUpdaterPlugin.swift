import Foundation
import UIKit
import WebKit
import Capacitor
import CryptoKit
import zlib

public struct OtaStateRecord: Codable {
    public var builtInNativeKey: String
    public var activeBuild: String?
    public var lastGoodBuild: String?
    public var pendingBuild: String?
    public var bootAttempts: Int
    public var lastRollbackReason: String
    public var updatedAt: String
}

public final class TwinkleWebOtaStore {
    public static let shared = TwinkleWebOtaStore()

    private let fm = FileManager.default
    private let lock = NSLock()
    private var watchdogWorkItem: DispatchWorkItem?
    private weak var boundBridge: CAPBridgeProtocol?

    private init() {}

    public var nativeVersion: String {
        return (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0.0"
    }

    public var nativeBuildCode: Int {
        let raw = (Bundle.main.infoDictionary?["CFBundleVersion"] as? String) ?? "1"
        return Int(raw) ?? 1
    }

    private var nativeKey: String {
        return "\(nativeVersion)(\(nativeBuildCode))"
    }

    private var otaRootDir: URL {
        let libDir = fm.urls(for: .libraryDirectory, in: .userDomainMask).first!
        return libDir
            .appendingPathComponent("NoCloud", isDirectory: true)
            .appendingPathComponent("twinklebot_ota", isDirectory: true)
    }

    private var releasesDir: URL {
        return otaRootDir.appendingPathComponent("releases", isDirectory: true)
    }

    private var stateFileUrl: URL {
        return otaRootDir.appendingPathComponent("ota-state.json", isDirectory: false)
    }

    private var builtInPublicUrl: URL? {
        return Bundle.main.url(forResource: "public", withExtension: nil)
    }

    public func attachBridge(_ bridge: CAPBridgeProtocol?) {
        lock.lock()
        boundBridge = bridge
        lock.unlock()
    }

    private func sanitizeBuildId(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != ".", trimmed != ".." else { return nil }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-")
        let mapped = trimmed.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
        return String(mapped)
    }

    private func releaseDir(for buildId: String) -> URL? {
        guard let safe = sanitizeBuildId(buildId) else { return nil }
        return releasesDir.appendingPathComponent(safe, isDirectory: true)
    }

    private func hasValidRelease(_ buildId: String?) -> Bool {
        guard let buildId, let dir = releaseDir(for: buildId) else { return false }
        let idx = dir.appendingPathComponent("index.html", isDirectory: false)
        return fm.fileExists(atPath: idx.path)
    }

    private func loadStateLocked() -> OtaStateRecord {
        if let data = try? Data(contentsOf: stateFileUrl),
           let decoded = try? JSONDecoder().decode(OtaStateRecord.self, from: data),
           decoded.builtInNativeKey == nativeKey {
            return decoded
        }
        // Native iOS shell upgraded (or first run): wipe old OTA releases cleanly
        try? fm.removeItem(at: releasesDir)
        try? fm.createDirectory(at: releasesDir, withIntermediateDirectories: true)
        let fresh = OtaStateRecord(
            builtInNativeKey: nativeKey,
            activeBuild: nil,
            lastGoodBuild: nil,
            pendingBuild: nil,
            bootAttempts: 0,
            lastRollbackReason: "",
            updatedAt: ISO8601DateFormatter().string(from: Date())
        )
        saveStateLocked(fresh)
        return fresh
    }

    private func saveStateLocked(_ record: OtaStateRecord) {
        try? fm.createDirectory(at: otaRootDir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(record) {
            try? data.write(to: stateFileUrl, options: [.atomic])
        }
    }

    /// Invoked from `instanceDescriptor()` before WKWebView starts loading.
    public func prepareLaunchAppLocation() -> URL? {
        lock.lock()
        var st = loadStateLocked()

        if st.lastGoodBuild != nil && !hasValidRelease(st.lastGoodBuild) {
            st.lastGoodBuild = nil
        }

        if let pending = st.pendingBuild {
            st.bootAttempts += 1
            if st.bootAttempts >= 2 || !hasValidRelease(pending) {
                let fallback = hasValidRelease(st.lastGoodBuild) ? st.lastGoodBuild : nil
                st.lastRollbackReason = "版本 \(pending) 启动确认失败，已自动回滚至\(fallback ?? "内置基线版")"
                st.activeBuild = fallback
                st.pendingBuild = nil
                st.bootAttempts = 0
                if let badDir = releaseDir(for: pending) {
                    try? fm.removeItem(at: badDir)
                }
            }
        } else if st.activeBuild != nil && !hasValidRelease(st.activeBuild) {
            st.activeBuild = hasValidRelease(st.lastGoodBuild) ? st.lastGoodBuild : nil
        }

        st.updatedAt = ISO8601DateFormatter().string(from: Date())
        saveStateLocked(st)
        let pendingToWatch = st.pendingBuild
        let activeUrl = st.activeBuild.flatMap { releaseDir(for: $0) }
        lock.unlock()

        if let pendingToWatch {
            armWatchdog(for: pendingToWatch)
        }
        return activeUrl
    }

    public func currentStateSnapshot() -> [String: Any] {
        lock.lock()
        let st = loadStateLocked()
        let activeDir = st.activeBuild.flatMap { releaseDir(for: $0) }
        let usingBuiltIn = (activeDir == nil)
        lock.unlock()

        var webBuild = ""
        if let metaUrl = (activeDir ?? builtInPublicUrl)?.appendingPathComponent("web-meta.json"),
           let data = try? Data(contentsOf: metaUrl),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let wb = obj["webBuild"] as? String {
            webBuild = wb
        }

        return [
            "platform": "ios",
            "nativeVersion": nativeVersion,
            "nativeBuildCode": nativeBuildCode,
            "activeWebBuild": webBuild.isEmpty ? (st.activeBuild ?? "") : webBuild,
            "activeBuildId": st.activeBuild ?? "",
            "lastGoodBuild": st.lastGoodBuild ?? "",
            "pendingBuild": st.pendingBuild ?? "",
            "lastRollbackReason": st.lastRollbackReason,
            "usingBuiltIn": usingBuiltIn
        ]
    }

    private func armWatchdog(for buildId: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.watchdogWorkItem?.cancel()
            let item = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let stillPending = self.loadStateLocked().pendingBuild == buildId
                self.lock.unlock()
                if stillPending {
                    self.performRollback(reason: "前端热更新包 \(buildId) 超过 5 秒未就绪，已自动回滚", resetToBuiltIn: false)
                }
            }
            self.watchdogWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 5.0, execute: item)
        }
    }

    public func confirmReady(webBuild: String?) -> [String: Any] {
        DispatchQueue.main.async { [weak self] in
            self?.watchdogWorkItem?.cancel()
            self?.watchdogWorkItem = nil
        }
        lock.lock()
        var st = loadStateLocked()
        if let pending = st.pendingBuild, (webBuild == nil || webBuild!.isEmpty || webBuild == pending) {
            let oldGood = st.lastGoodBuild
            st.activeBuild = pending
            st.lastGoodBuild = pending
            st.pendingBuild = nil
            st.bootAttempts = 0
            st.lastRollbackReason = ""
            st.updatedAt = ISO8601DateFormatter().string(from: Date())
            saveStateLocked(st)
            if let dirs = try? fm.contentsOfDirectory(at: releasesDir, includingPropertiesForKeys: nil) {
                for d in dirs {
                    let name = d.lastPathComponent
                    if name != pending && name != oldGood {
                        try? fm.removeItem(at: d)
                    }
                }
            }
        } else if st.bootAttempts > 0 {
            st.bootAttempts = 0
            saveStateLocked(st)
        }
        lock.unlock()
        return currentStateSnapshot()
    }

    public func performRollback(reason: String, resetToBuiltIn: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.watchdogWorkItem?.cancel()
            self?.watchdogWorkItem = nil
        }

        lock.lock()
        var st = loadStateLocked()
        let failed = st.pendingBuild ?? st.activeBuild
        let fallback = (!resetToBuiltIn && st.lastGoodBuild != failed && hasValidRelease(st.lastGoodBuild))
            ? st.lastGoodBuild
            : nil

        st.activeBuild = fallback
        st.pendingBuild = nil
        st.bootAttempts = 0
        st.lastRollbackReason = resetToBuiltIn ? "" : reason
        st.updatedAt = ISO8601DateFormatter().string(from: Date())
        saveStateLocked(st)

        if resetToBuiltIn {
            try? fm.removeItem(at: releasesDir)
            try? fm.createDirectory(at: releasesDir, withIntermediateDirectories: true)
        } else if let failed, failed != fallback, let badDir = releaseDir(for: failed) {
            try? fm.removeItem(at: badDir)
        }

        let targetDir = fallback.flatMap { releaseDir(for: $0) } ?? builtInPublicUrl
        let bridge = boundBridge
        lock.unlock()

        DispatchQueue.main.async {
            if let targetDir, let bridge {
                bridge.setServerBasePath(targetDir.path)
                if let url = URL(string: bridge.getLocalUrl()) {
                    bridge.webView?.load(URLRequest(url: url))
                }
            }
        }
    }

    public func installAndReload(tarGzData: Data, expectedSha256: String, webBuild: String) throws {
        guard let cleanBuild = sanitizeBuildId(webBuild) else {
            throw NSError(domain: "WebUpdater", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid webBuild"])
        }
        let digest = SHA256.hash(data: tarGzData).map { String(format: "%02x", $0) }.joined()
        guard digest.lowercased() == expectedSha256.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else {
            throw NSError(domain: "WebUpdater", code: 2, userInfo: [NSLocalizedDescriptionKey: "SHA-256 校验失败"])
        }

        let tarData = try gunzip(tarGzData)
        let stageDir = otaRootDir.appendingPathComponent("stage-\(cleanBuild)-\(Int(Date().timeIntervalSince1970))", isDirectory: true)
        try? fm.removeItem(at: stageDir)
        try fm.createDirectory(at: stageDir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: stageDir) }

        try extractUstarSafely(tarData: tarData, destDir: stageDir)
        let idxUrl = stageDir.appendingPathComponent("index.html", isDirectory: false)
        guard fm.fileExists(atPath: idxUrl.path) else {
            throw NSError(domain: "WebUpdater", code: 3, userInfo: [NSLocalizedDescriptionKey: "热更新包缺少 index.html"])
        }

        guard let targetDir = releaseDir(for: cleanBuild) else {
            throw NSError(domain: "WebUpdater", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid release path"])
        }
        try? fm.removeItem(at: targetDir)
        try fm.createDirectory(at: releasesDir, withIntermediateDirectories: true)
        try fm.moveItem(at: stageDir, to: targetDir)

        lock.lock()
        var st = loadStateLocked()
        let prevStable = (st.activeBuild != nil && st.pendingBuild == nil && hasValidRelease(st.activeBuild))
            ? st.activeBuild
            : st.lastGoodBuild
        st.activeBuild = cleanBuild
        st.lastGoodBuild = prevStable
        st.pendingBuild = cleanBuild
        st.bootAttempts = 0
        st.lastRollbackReason = ""
        st.updatedAt = ISO8601DateFormatter().string(from: Date())
        saveStateLocked(st)
        let bridge = boundBridge
        lock.unlock()

        armWatchdog(for: cleanBuild)

        DispatchQueue.main.async {
            if let bridge {
                bridge.setServerBasePath(targetDir.path)
                if let url = URL(string: bridge.getLocalUrl()) {
                    bridge.webView?.load(URLRequest(url: url))
                }
            }
        }
    }

    private func gunzip(_ input: Data) throws -> Data {
        guard !input.isEmpty else { return Data() }
        var stream = z_stream()
        let initStatus = inflateInit2_(&stream, MAX_WBITS + 32, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard initStatus == Z_OK else {
            throw NSError(domain: "WebUpdater", code: 10, userInfo: [NSLocalizedDescriptionKey: "zlib init failed"])
        }
        defer { inflateEnd(&stream) }

        var output = Data(capacity: min(32 * 1024 * 1024, input.count * 4))
        let chunkSize = 64 * 1024
        var buffer = [UInt8](repeating: 0, count: chunkSize)
        var status: Int32 = Z_OK

        try input.withUnsafeBytes { (rawBuf: UnsafeRawBufferPointer) in
            guard let basePtr = rawBuf.bindMemory(to: Bytef.self).baseAddress else { return }
            stream.next_in = UnsafeMutablePointer<Bytef>(mutating: basePtr)
            stream.avail_in = uInt(input.count)

            while true {
                let produced: Int = try buffer.withUnsafeMutableBufferPointer { outPtr in
                    stream.next_out = outPtr.baseAddress
                    stream.avail_out = uInt(chunkSize)
                    status = inflate(&stream, Z_NO_FLUSH)
                    if status != Z_OK && status != Z_STREAM_END {
                        throw NSError(domain: "WebUpdater", code: 11, userInfo: [NSLocalizedDescriptionKey: "gzip 解压失败 (\(status))"])
                    }
                    return chunkSize - Int(stream.avail_out)
                }
                if produced > 0 {
                    output.append(buffer, count: produced)
                    if output.count > 34 * 1024 * 1024 {
                        throw NSError(domain: "WebUpdater", code: 12, userInfo: [NSLocalizedDescriptionKey: "解压体积超出安全上限"])
                    }
                }
                if status == Z_STREAM_END || stream.avail_in == 0 && produced == 0 {
                    break
                }
            }
        }
        return output
    }

    private func readTarString(_ slice: Data) -> String {
        if let zero = slice.firstIndex(of: 0) {
            return String(data: slice[..<zero], encoding: .utf8) ?? ""
        }
        return String(data: slice, encoding: .utf8) ?? ""
    }

    private func readTarOctal(_ slice: Data) -> Int {
        let s = readTarString(slice).trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return 0 }
        return Int(s, radix: 8) ?? 0
    }

    private func extractUstarSafely(tarData: Data, destDir: URL) throws {
        var offset = 0
        let rootResolved = destDir.standardizedFileURL.path
        var fileCount = 0

        while offset + 512 <= tarData.count {
            let header = tarData[offset..<(offset + 512)]
            offset += 512
            if header.allSatisfy({ $0 == 0 }) { break }

            let name = readTarString(header[header.startIndex..<(header.startIndex + 100)])
            let prefix = readTarString(header[(header.startIndex + 345)..<(header.startIndex + 500)])
            let rawRel = prefix.isEmpty ? name : "\(prefix)/\(name)"
            let typeByte = header[header.startIndex + 156]
            let size = readTarOctal(header[(header.startIndex + 124)..<(header.startIndex + 136)])

            let padded = ((size + 511) / 512) * 512
            guard offset + padded <= tarData.count else {
                throw NSError(domain: "WebUpdater", code: 20, userInfo: [NSLocalizedDescriptionKey: "tar 归档截断"])
            }
            let payload = tarData[offset..<(offset + size)]
            offset += padded

            // Reject symlinks/hardlinks ('1' = 49, '2' = 50)
            if typeByte == 49 || typeByte == 50 {
                throw NSError(domain: "WebUpdater", code: 21, userInfo: [NSLocalizedDescriptionKey: "拒绝非法链接条目"])
            }
            if typeByte == 120 || typeByte == 103 { continue } // 'x' / 'g'

            let cleaned = rawRel
                .replacingOccurrences(of: "\\", with: "/")
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if cleaned.isEmpty { continue }
            let parts = cleaned.split(separator: "/").map(String.init)
            if parts.contains(".") || parts.contains("..") {
                throw NSError(domain: "WebUpdater", code: 22, userInfo: [NSLocalizedDescriptionKey: "拒绝越界路径"])
            }

            var targetUrl = destDir
            for p in parts {
                targetUrl.appendPathComponent(p, isDirectory: false)
            }
            let resolvedPath = targetUrl.standardizedFileURL.path
            guard resolvedPath == rootResolved || resolvedPath.hasPrefix(rootResolved + "/") else {
                throw NSError(domain: "WebUpdater", code: 23, userInfo: [NSLocalizedDescriptionKey: "Tar-Slip 路径校验拦截"])
            }

            if typeByte == 53 { // '5' directory
                try fm.createDirectory(at: targetUrl, withIntermediateDirectories: true)
            } else if typeByte == 48 || typeByte == 0 {
                fileCount += 1
                if fileCount > 1000 {
                    throw NSError(domain: "WebUpdater", code: 24, userInfo: [NSLocalizedDescriptionKey: "归档文件数量超出限制"])
                }
                try fm.createDirectory(at: targetUrl.deletingLastPathComponent(), withIntermediateDirectories: true)
                try payload.write(to: targetUrl, options: [.atomic])
            }
        }
    }
}

@objc(WebUpdaterPlugin)
public class WebUpdaterPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebUpdaterPlugin"
    public let jsName = "WebUpdater"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchManifest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadAndApply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rollbackToBuiltIn", returnType: CAPPluginReturnPromise)
    ]

    private func isTrustedGithubUrl(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased() else {
            return false
        }
        let path = url.path.lowercased()
        if host == "github.com" {
            return path.range(of: #"^/caixy-plus/[a-z0-9._-]+/releases/"#, options: .regularExpression) != nil
        }
        if host == "api.github.com" {
            return path.range(of: #"^/repos/caixy-plus/[a-z0-9._-]+/releases(/|$)"#, options: .regularExpression) != nil
        }
        return host == "objects.githubusercontent.com"
            || host == "release-assets.githubusercontent.com"
            || host == "github-releases.githubusercontent.com"
            || host.hasSuffix(".githubusercontent.com")
    }

    @objc func getState(_ call: CAPPluginCall) {
        TwinkleWebOtaStore.shared.attachBridge(bridge)
        call.resolve(TwinkleWebOtaStore.shared.currentStateSnapshot())
    }

    @objc func fetchManifest(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"),
              let url = URL(string: urlStr),
              isTrustedGithubUrl(url) else {
            call.reject("Untrusted or invalid GitHub URL")
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        req.setValue("TwinkleBot-iOS/1.0.0", forHTTPHeaderField: "User-Agent")
        req.setValue("application/json, application/vnd.github+json", forHTTPHeaderField: "Accept")

        URLSession.shared.dataTask(with: req) { [weak self] data, response, err in
            if let err {
                call.reject("网络请求失败: \(err.localizedDescription)")
                return
            }
            if let finalUrl = response?.url, !(self?.isTrustedGithubUrl(finalUrl) ?? false) {
                call.reject("拒绝未受信任的重定向域名")
                return
            }
            if let httpRes = response as? HTTPURLResponse, !(200..<300).contains(httpRes.statusCode) {
                call.reject("HTTP \(httpRes.statusCode)")
                return
            }
            guard let data, let text = String(data: data, encoding: .utf8) else {
                call.reject("响应内容为空")
                return
            }
            call.resolve(["ok": true, "jsonText": text])
        }.resume()
    }

    @objc func confirmReady(_ call: CAPPluginCall) {
        let webBuild = call.getString("webBuild")
        call.resolve(TwinkleWebOtaStore.shared.confirmReady(webBuild: webBuild))
    }

    @objc func rollbackToBuiltIn(_ call: CAPPluginCall) {
        TwinkleWebOtaStore.shared.attachBridge(bridge)
        TwinkleWebOtaStore.shared.performRollback(reason: "用户手动恢复内置界面", resetToBuiltIn: true)
        call.resolve(TwinkleWebOtaStore.shared.currentStateSnapshot())
    }

    @objc func downloadAndApply(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"),
              let url = URL(string: urlStr),
              isTrustedGithubUrl(url),
              let sha256 = call.getString("sha256"),
              let webBuild = call.getString("webBuild") else {
            call.reject("Missing or untrusted GitHub url, sha256, or webBuild")
            return
        }
        TwinkleWebOtaStore.shared.attachBridge(bridge)

        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 45)
        req.setValue("TwinkleBot-iOS/1.0.0", forHTTPHeaderField: "User-Agent")

        notifyListeners("otaProgress", data: ["phase": "downloading", "percent": 20, "message": "正在从 GitHub Releases 下载热更新包…"])
        URLSession.shared.dataTask(with: req) { [weak self] data, response, err in
            if let err {
                call.reject("下载失败: \(err.localizedDescription)")
                return
            }
            if let finalUrl = response?.url, !(self?.isTrustedGithubUrl(finalUrl) ?? false) {
                call.reject("更新包重定向到了未受信任地址")
                return
            }
            if let httpRes = response as? HTTPURLResponse, !(200..<300).contains(httpRes.statusCode) {
                call.reject("下载失败: HTTP \(httpRes.statusCode)")
                return
            }
            guard let data else {
                call.reject("下载响应为空")
                return
            }
            self?.notifyListeners("otaProgress", data: ["phase": "extracting", "percent": 75, "message": "校验并切换前端资源…"])
            do {
                try TwinkleWebOtaStore.shared.installAndReload(tarGzData: data, expectedSha256: sha256, webBuild: webBuild)
                self?.notifyListeners("otaProgress", data: ["phase": "done", "percent": 100, "message": "热更新成功，正在重载…"])
                call.resolve(TwinkleWebOtaStore.shared.currentStateSnapshot())
            } catch {
                call.reject("热更新失败: \(error.localizedDescription)")
            }
        }.resume()
    }
}
