import Foundation
import UIKit
import WebKit
import ObjectiveC.runtime
import Capacitor
import Network
import AVFoundation

@objc(LanDiscoveryPlugin)
public class LanDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LanDiscoveryPlugin"
    public let jsName = "LanDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getNetworkInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setScreenOrientation", returnType: CAPPluginReturnPromise)
    ]

    private func currentWifiIpv4() -> (ip: String, prefix: String) {
        var address = ""
        var prefix = ""
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr {
            defer { freeifaddrs(firstAddr) }
            var ptr: UnsafeMutablePointer<ifaddrs>? = firstAddr
            while let current = ptr {
                let flags = Int32(current.pointee.ifa_flags)
                let addr = current.pointee.ifa_addr.pointee
                if (flags & (IFF_UP | IFF_RUNNING | IFF_LOOPBACK)) == (IFF_UP | IFF_RUNNING),
                   addr.sa_family == UInt8(AF_INET),
                   let name = String(validatingUTF8: current.pointee.ifa_name),
                   name.hasPrefix("en") {
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(current.pointee.ifa_addr, socklen_t(addr.sa_len), &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                        let ip = String(cString: hostname)
                        let parts = ip.split(separator: ".")
                        if parts.count == 4 {
                            address = ip
                            prefix = "\(parts[0]).\(parts[1]).\(parts[2])"
                            break
                        }
                    }
                }
                ptr = current.pointee.ifa_next
            }
        }
        return (address, prefix)
    }

    @objc func getNetworkInfo(_ call: CAPPluginCall) {
        let info = currentWifiIpv4()
        call.resolve([
            "ip": info.ip,
            "subnetPrefix": info.prefix,
            "isWifi": !info.ip.isEmpty
        ])
    }

    @objc func discover(_ call: CAPPluginCall) {
        let timeoutMs = max(400, min(4000, call.getInt("timeoutMs") ?? 1200))
        DispatchQueue.global(qos: .userInitiated).async {
            var found: [String: [String: Any]] = [:]
            let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
            if fd >= 0 {
                defer { close(fd) }
                var broadcast: Int32 = 1
                setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &broadcast, socklen_t(MemoryLayout<Int32>.size))
                var tv = timeval(tv_sec: 0, tv_usec: 350_000)
                setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

                var dst = sockaddr_in()
                dst.sin_family = sa_family_t(AF_INET)
                dst.sin_port = in_port_t(41234).bigEndian
                dst.sin_addr.s_addr = INADDR_BROADCAST

                let probe = "TWINKLEBOT_DISCOVER_V1"
                _ = probe.withCString { cstr in
                    withUnsafePointer(to: &dst) { ptr in
                        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                            sendto(fd, cstr, strlen(cstr), 0, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
                        }
                    }
                }

                let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
                var buf = [UInt8](repeating: 0, count: 4096)
                while Date() < deadline {
                    var src = sockaddr_in()
                    var srclen = socklen_t(MemoryLayout<sockaddr_in>.size)
                    let n = withUnsafeMutablePointer(to: &src) { ptr in
                        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                            recvfrom(fd, &buf, buf.count, 0, sa, &srclen)
                        }
                    }
                    if n > 0 {
                        let data = Data(bytes: buf, count: n)
                        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           (obj["type"] as? String) == "TWINKLEBOT_OFFER_V1",
                           let instanceId = obj["instanceId"] as? String, !instanceId.isEmpty {
                            let hostStr = String(cString: inet_ntoa(src.sin_addr))
                            let port = (obj["port"] as? Int) ?? 3230
                            found[instanceId] = [
                                "instanceId": instanceId,
                                "hostname": (obj["hostname"] as? String) ?? hostStr,
                                "platform": (obj["platform"] as? String) ?? "",
                                "port": port,
                                "host": hostStr,
                                "baseUrl": "http://\(hostStr):\(port)",
                                "appVersion": (obj["appVersion"] as? String) ?? "",
                                "lanAccessEnabled": (obj["lanAccessEnabled"] as? Bool) ?? true
                            ]
                        }
                    }
                }
            }
            call.resolve(["devices": Array(found.values)])
        }
    }

    @objc func setScreenOrientation(_ call: CAPPluginCall) {
        let mode = call.getString("mode") ?? "portrait"
        let allowLandscape = mode.lowercased() == "sensor"
        DispatchQueue.main.async {
            AppDelegate.orientationMask = allowLandscape ? .allButUpsideDown : .portrait
            if #available(iOS 16.0, *) {
                for scene in UIApplication.shared.connectedScenes {
                    if let windowScene = scene as? UIWindowScene {
                        let prefs = UIWindowScene.GeometryPreferences.iOS(
                            interfaceOrientations: allowLandscape ? .allButUpsideDown : .portrait
                        )
                        windowScene.requestGeometryUpdate(prefs) { _ in }
                    }
                }
            }
            if !allowLandscape {
                UIDevice.current.setValue(UIInterfaceOrientation.portrait.rawValue, forKey: "orientation")
            }
            if #available(iOS 16.0, *) {
                self.bridge?.viewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            } else {
                UIViewController.attemptRotationToDeviceOrientation()
            }
            call.resolve()
        }
    }
}

private enum WKAccessoryBarHider {
    private static var installed = false
    private static let selector = NSSelectorFromString("inputAccessoryView")
    private static let nilImp: @convention(c) (AnyObject, Selector) -> AnyObject? = { _, _ in nil }

    static func installIfNeeded() {
        guard !installed else { return }
        installed = true
        guard let wkContentViewClass = NSClassFromString("WKContentView") else { return }
        let imp = unsafeBitCast(nilImp, to: IMP.self)
        if let method = class_getInstanceMethod(wkContentViewClass, selector) {
            method_setImplementation(method, imp)
        } else {
            class_addMethod(wkContentViewClass, selector, imp, "@@:")
        }
    }
}

class TwinkleBotBridgeViewController: CAPBridgeViewController, UIScrollViewDelegate {
    private var scrollOffsetObservation: NSKeyValueObservation?
    private var isResettingScrollOffset = false

    private func disableWebViewDoubleTapAndPinchZoom() {
        guard let wv = webView else { return }
        wv.allowsLinkPreview = false
        let scrollView = wv.scrollView
        scrollView.minimumZoomScale = 1.0
        scrollView.maximumZoomScale = 1.0
        scrollView.bouncesZoom = false
        scrollView.pinchGestureRecognizer?.isEnabled = false
        scrollView.delegate = self

        let targets: [UIView] = [wv, scrollView] + scrollView.subviews
        for target in targets {
            for gesture in target.gestureRecognizers ?? [] {
                if let tap = gesture as? UITapGestureRecognizer, tap.numberOfTapsRequired == 2 {
                    tap.isEnabled = false
                } else if gesture is UIPinchGestureRecognizer {
                    gesture.isEnabled = false
                }
            }
        }
    }

    override open func viewDidLoad() {
        super.viewDidLoad()
        WKAccessoryBarHider.installIfNeeded()
        let bg = UIColor(red: 20.0 / 255.0, green: 20.0 / 255.0, blue: 22.0 / 255.0, alpha: 1.0)
        view.backgroundColor = bg
        webView?.isOpaque = false
        webView?.backgroundColor = bg
        if let scrollView = webView?.scrollView {
            scrollView.backgroundColor = bg
            scrollView.bounces = false
            scrollView.alwaysBounceVertical = false
            scrollView.alwaysBounceHorizontal = false
            scrollView.showsVerticalScrollIndicator = false
            scrollView.showsHorizontalScrollIndicator = false
            scrollView.contentInsetAdjustmentBehavior = .never
            disableWebViewDoubleTapAndPinchZoom()
            // Keep isScrollEnabled = true so inner CSS overflow-y:auto scrollers
            // (WKChildScrollView like #session-list and #event-stream) receive touch pans,
            // while pinning only the outer root WKScrollView offset to .zero on keyboard focus.
            scrollOffsetObservation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] sv, _ in
                guard let self, !self.isResettingScrollOffset else { return }
                if abs(sv.contentOffset.x) > 0.5 || abs(sv.contentOffset.y) > 0.5 {
                    self.isResettingScrollOffset = true
                    sv.setContentOffset(.zero, animated: false)
                    self.isResettingScrollOffset = false
                }
            }
        }
    }

    override open func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        disableWebViewDoubleTapAndPinchZoom()
    }

    public func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        return nil
    }

    override open func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let otaLocation = TwinkleWebOtaStore.shared.prepareLaunchAppLocation() {
            descriptor.appLocation = otaLocation
        }
        return descriptor
    }

    override open func capacitorDidLoad() {
        TwinkleWebOtaStore.shared.attachBridge(bridge)
        bridge?.registerPluginInstance(LanDiscoveryPlugin())
        bridge?.registerPluginInstance(QrScannerPlugin())
        bridge?.registerPluginInstance(WebUpdaterPlugin())
    }
}

final class QrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var promptText: String = ""
    var onResult: ((_ content: String?, _ cancelled: Bool) -> Void)?

    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let videoDevice = AVCaptureDevice.default(for: .video),
              let videoInput = try? AVCaptureDeviceInput(device: videoDevice),
              captureSession.canAddInput(videoInput) else {
            finish(content: nil, cancelled: true)
            return
        }
        captureSession.addInput(videoInput)

        let metadataOutput = AVCaptureMetadataOutput()
        guard captureSession.canAddOutput(metadataOutput) else {
            finish(content: nil, cancelled: true)
            return
        }
        captureSession.addOutput(metadataOutput)
        metadataOutput.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        metadataOutput.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: captureSession)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.layer.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        setupOverlayUI()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.captureSession.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.layer.bounds
    }

    private func setupOverlayUI() {
        let reticleSize: CGFloat = 240
        let reticle = UIView()
        reticle.translatesAutoresizingMaskIntoConstraints = false
        reticle.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
        reticle.layer.borderWidth = 2
        reticle.layer.cornerRadius = 16
        reticle.backgroundColor = .clear
        view.addSubview(reticle)

        let promptLabel = UILabel()
        promptLabel.translatesAutoresizingMaskIntoConstraints = false
        promptLabel.text = promptText.isEmpty ? "请将桌面端外网中继二维码放入框内" : promptText
        promptLabel.textColor = .white
        promptLabel.font = UIFont.systemFont(ofSize: 14, weight: .medium)
        promptLabel.textAlignment = .center
        promptLabel.numberOfLines = 2
        view.addSubview(promptLabel)

        let cancelBtn = UIButton(type: .system)
        cancelBtn.translatesAutoresizingMaskIntoConstraints = false
        cancelBtn.setTitle("取消", for: .normal)
        cancelBtn.setTitleColor(.white, for: .normal)
        cancelBtn.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
        cancelBtn.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        cancelBtn.layer.cornerRadius = 22
        cancelBtn.contentEdgeInsets = UIEdgeInsets(top: 10, left: 26, bottom: 10, right: 26)
        cancelBtn.addTarget(self, action: #selector(handleCancel), for: .touchUpInside)
        view.addSubview(cancelBtn)

        NSLayoutConstraint.activate([
            reticle.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            reticle.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -24),
            reticle.widthAnchor.constraint(equalToConstant: reticleSize),
            reticle.heightAnchor.constraint(equalToConstant: reticleSize),

            promptLabel.topAnchor.constraint(equalTo: reticle.bottomAnchor, constant: 20),
            promptLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            promptLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),

            cancelBtn.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
            cancelBtn.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
    }

    @objc private func handleCancel() {
        finish(content: nil, cancelled: true)
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !finished,
              let readable = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let raw = readable.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return
        }
        finish(content: raw, cancelled: false)
    }

    private func finish(content: String?, cancelled: Bool) {
        guard !finished else { return }
        finished = true
        if captureSession.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [session = captureSession] in
                session.stopRunning()
            }
        }
        dismiss(animated: true) { [onResult] in
            onResult?(content, cancelled)
        }
    }
}

@objc(QrScannerPlugin)
public class QrScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QrScannerPlugin"
    public let jsName = "QrScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

    @objc func scan(_ call: CAPPluginCall) {
        let prompt = call.getString("prompt") ?? ""
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            presentScanner(call, prompt: prompt)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                if granted {
                    self?.presentScanner(call, prompt: prompt)
                } else {
                    call.resolve(["ok": false, "permissionDenied": true])
                }
            }
        default:
            call.resolve(["ok": false, "permissionDenied": true])
        }
    }

    private func presentScanner(_ call: CAPPluginCall, prompt: String) {
        DispatchQueue.main.async { [weak self] in
            guard let vc = self?.bridge?.viewController else {
                call.resolve(["ok": false, "error": "ViewController unavailable"])
                return
            }
            let scanner = QrScannerViewController()
            scanner.modalPresentationStyle = .fullScreen
            scanner.promptText = prompt
            scanner.onResult = { content, cancelled in
                if let content, !content.isEmpty {
                    call.resolve(["ok": true, "content": content])
                } else {
                    call.resolve(["ok": false, "cancelled": cancelled])
                }
            }
            vc.present(scanner, animated: true)
        }
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = TwinkleBotBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
