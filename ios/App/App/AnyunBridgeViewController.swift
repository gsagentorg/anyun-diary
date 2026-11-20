//
//  AnyunBridgeViewController.swift
//  App
//
//  UNVERIFIED: 未在 macOS/Xcode 编译，未真机验证
//
//  在标准 CAPBridgeViewController 上做两件事：
//  1. 往 WKWebViewConfiguration 注册 `anyun-cache` scheme handler（本类强引用该 handler，
//     因为 WKWebView 对 scheme handler 只持弱引用）；
//  2. `capacitorDidLoad()` 里注册原生插件（原生播放 NativePlayback + 磁盘缓存 AnyunCache）。
//
//  本类的 scheme handler 只服务网页层的 `<audio>` 与 JSON 取数；原生播放走 AVPlayer 直连后端。
//

import UIKit
import Capacitor
import WebKit

class AnyunBridgeViewController: CAPBridgeViewController {
    /// WKWebView 只弱持有 scheme handler，必须由我们自己保活。
    private var cacheSchemeHandler: AnyunCacheSchemeHandler?

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        let handler = AnyunCacheSchemeHandler()
        cacheSchemeHandler = handler
        configuration.setURLSchemeHandler(handler, forURLScheme: AnyunCacheConstants.scheme)
        return configuration
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(NativePlaybackPlugin())
        bridge?.registerPluginInstance(AnyunCachePlugin())
    }
}