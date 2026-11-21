//
//  AnyunCachePlugin.swift
//  App
//
//  UNVERIFIED: 未在 macOS/Xcode 编译，未真机验证
//
//  Capacitor 插件 `AnyunCache`：configure / setPolicy / stats / clear / fetchJSON。
//  fetchJSON 走同一套磁盘缓存，但 SWR 比音频激进：jsonStaleSeconds 窗口内直接回 cache 并后台 revalidate，
//  过窗先网络，网络失败且有缓存 ⇒ source=stale + offline=true，无缓存 ⇒ reject(UNAVAILABLE)。
//

import Foundation
import Capacitor

@objc(AnyunCachePlugin)
public class AnyunCachePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AnyunCachePlugin"
    public let jsName = "AnyunCache"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPolicy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stats", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchJSON", returnType: CAPPluginReturnPromise)
    ]

    private var disk: AnyunDiskCache { return AnyunDiskCache.shared }
    private var network: AnyunCacheNetwork { return AnyunCacheNetwork.shared }
    private var policyStore: AnyunCachePolicyStore { return AnyunCachePolicyStore.shared }

    // MARK: - configure / setPolicy

    @objc public func configure(_ call: CAPPluginCall) {
        Task {
            if let requested = self.policyObject(from: call) {
                _ = self.policyStore.save(requested)
            } else if self.policyStore.loadIfPresent() == nil {
                _ = self.policyStore.save(AnyunCachePolicy.default)
            }
            let effective = self.policyStore.load()
            call.resolve(["policy": effective.dictionaryRepresentation])
        }
    }

    @objc public func setPolicy(_ call: CAPPluginCall) {
        Task {
            guard let requested = self.policyObject(from: call) else {
                call.reject("缺少 policy 参数", "BAD_POLICY")
                return
            }
            let effective = self.policyStore.save(requested)
            call.resolve(["policy": effective.dictionaryRepresentation])
        }
    }

    // MARK: - stats / clear

    @objc public func stats(_ call: CAPPluginCall) {
        Task {
            let snapshot = await self.disk.stats()
            call.resolve([
                "bytes": snapshot.bytes,
                "entries": snapshot.entries,
                "mediaEntries": snapshot.mediaEntries,
                "jsonEntries": snapshot.jsonEntries,
                "maxBytes": snapshot.maxBytes,
                "cacheDir": snapshot.cacheDir
            ])
        }
    }

    @objc public func clear(_ call: CAPPluginCall) {
        Task {
            let scope = call.getString("scope") ?? "all"
            let result = await self.disk.clear(scope: scope)
            call.resolve([
                "freedBytes": result.freedBytes,
                "entries": result.entries
            ])
        }
    }

    // MARK: - fetchJSON

    @objc public func fetchJSON(_ call: CAPPluginCall) {
        Task {
            guard let raw = call.getString("url"),
                  let url = URL(string: raw),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "https" || scheme == "http" else {
                call.reject("链接无效或不是 https", "BAD_URL")
                return
            }

            let force = call.getBool("force") ?? false
            let key = AnyunCacheKey.hash(url.absoluteString)
            let policy = self.policyStore.load()
            let request: AnyunJSONRequest
            do { request = try await self.disk.beginJSONRequest(key: key) }
            catch { call.reject("缓存请求不可用", "UNAVAILABLE"); return }
            let cached = request.entry
            let now = Date().timeIntervalSince1970

            // 1) 新鲜窗口内：直接回 cache，后台静默 revalidate。
            if let entry = cached, !force {
                let age = max(0, now - entry.createdAt)
                if age <= Double(policy.jsonStaleSeconds), let data = request.data,
                   let object = AnyunCachePlugin.jsonObject(from: data) {
                    call.resolve([
                        "data": object,
                        "source": "cache",
                        "ageSeconds": Int(age),
                        "offline": false
                    ])
                    self.revalidateJSON(request: request, url: url, entry: entry)
                    return
                }
            }

            // 2) 过窗（或 force）：先走网络，带条件请求。
            do {
                let response = try await self.network.get(
                    url,
                    etag: force ? nil : cached?.etag,
                    lastModified: force ? nil : cached?.lastModified
                )

                if response.isNotModified, !force, cached != nil {
                    let data = try await self.disk.revalidateJSON(request: request)
                    guard let object = AnyunCachePlugin.jsonObject(from: data) else {
                        throw AnyunCachePayloadError.invalidJSON
                    }
                    call.resolve([
                        "data": object,
                        "source": "cache",
                        "ageSeconds": 0,
                        "offline": false
                    ])
                    await self.disk.finishJSONRequest(request)
                    return
                }

                guard response.status == 200 else {
                    throw AnyunCacheError.http(response.status)
                }
                guard let object = AnyunCachePlugin.jsonObject(from: response.data) else {
                    throw AnyunCachePayloadError.invalidJSON
                }

                _ = try? await self.disk.storeJSON(
                    request: request,
                    data: response.data,
                    etag: response.etag,
                    lastModified: response.lastModified,
                    contentType: response.contentType
                )
                call.resolve([
                    "data": object,
                    "source": "network",
                    "ageSeconds": 0,
                    "offline": false
                ])
            } catch {
                // 3) 网络失败：有缓存回 stale（不失效），无缓存明确报不可用。
                if let entry = cached, let data = request.data,
                   let object = AnyunCachePlugin.jsonObject(from: data) {
                    let age = max(0, Date().timeIntervalSince1970 - entry.createdAt)
                    call.resolve([
                        "data": object,
                        "source": "stale",
                        "ageSeconds": Int(age),
                        "offline": true
                    ])
                } else {
                    call.reject("离线且无缓存", "UNAVAILABLE")
                }
            }
            await self.disk.finishJSONRequest(request)
        }
    }

    // MARK: - 内部

    private func policyObject(from call: CAPPluginCall) -> AnyunCachePolicy? {
        guard let object = call.getObject("policy") else { return nil }
        var dictionary: [String: Any] = [:]
        for (key, value) in object {
            dictionary[key] = value
        }
        return AnyunCachePolicy.from(dictionary: dictionary)
    }

    /// Background SWR retains the ownership acquired before returning the cached snapshot.
    /// Clear/newer requests may reject its commit; network failure preserves the cached content.
    private func revalidateJSON(request: AnyunJSONRequest, url: URL, entry: AnyunCacheEntry) {
        let disk = self.disk
        let network = self.network
        Task.detached(priority: .utility) {
            do {
                let response = try await network.get(url, etag: entry.etag, lastModified: entry.lastModified)
                if response.isNotModified {
                    _ = try await disk.revalidateJSON(request: request)
                } else if response.status == 200, AnyunCachePlugin.jsonObject(from: response.data) != nil {
                    _ = try? await disk.storeJSON(
                        request: request,
                        data: response.data,
                        etag: response.etag,
                        lastModified: response.lastModified,
                        contentType: response.contentType
                    )
                }
            } catch {
                // 静默失败：保留缓存。
            }
            await disk.finishJSONRequest(request)
        }
    }

    static func jsonObject(from data: Data) -> Any? {
        guard !data.isEmpty else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }
}