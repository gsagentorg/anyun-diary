//
//  AnyunCacheSchemeHandler.swift
//  App
//
//  UNVERIFIED: 未在 macOS/Xcode 编译，未真机验证
//
//  `WKURLSchemeHandler`：处理 `anyun-cache://media?u=<percent-encoded https URL>`。
//  命中即回（支持 Range → 206），超出 revalidate 窗口时先回缓存再后台条件刷新；
//  未命中走网络，200 才写盘。任何失败都绝不删除已有缓存。
//

import Foundation
import WebKit

/// 单个 scheme task 的生命周期标记。
/// WKWebView 可能在任意时刻 stop 一个 task，而 stop 之后再回调 `didReceive/didFinish/didFail` 会崩，
/// 所以每次回调前都要 claim 一次（canceled 与 finished 都拒绝）。
final class AnyunSchemeTaskState: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var finished = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    func markFinished() {
        lock.lock()
        finished = true
        lock.unlock()
    }

    /// 是否可以继续向 WebKit 投递（未取消且未结束）。
    func claimDelivery() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if cancelled || finished {
            return false
        }
        return true
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled || finished
    }
}

final class AnyunCacheSchemeHandler: NSObject, WKURLSchemeHandler {
    private let disk: AnyunDiskCache
    private let network: AnyunCacheNetwork
    private let policyProvider: () -> AnyunCachePolicy

    /// 强引用自己持有的 task（WKWebView 只弱持有 scheme handler，这里再持有进行中的 task 以便 stop 时取消）。
    private var runningTasks: [ObjectIdentifier: (state: AnyunSchemeTaskState, work: Task<Void, Never>)] = [:]
    private let tasksLock = NSLock()

    init(
        disk: AnyunDiskCache = AnyunDiskCache.shared,
        network: AnyunCacheNetwork = AnyunCacheNetwork.shared,
        policyProvider: @escaping () -> AnyunCachePolicy = { AnyunCachePolicyStore.shared.load() }
    ) {
        self.disk = disk
        self.network = network
        self.policyProvider = policyProvider
        super.init()
    }

    // MARK: - WKURLSchemeHandler

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              let remoteURL = AnyunCacheSchemeHandler.remoteURL(from: requestURL) else {
            urlSchemeTask.didFailWithError(AnyunCacheError.badURL.nsError)
            return
        }

        let key = AnyunCacheKey.hash(remoteURL.absoluteString)
        let range = AnyunCacheSchemeHandler.parseRangeHeader(urlSchemeTask.request.value(forHTTPHeaderField: "Range"))
        let policy = policyProvider()
        let state = AnyunSchemeTaskState()

        let work = Task { [weak self] in
            guard let self = self else { return }
            await self.serve(
                state: state,
                task: urlSchemeTask,
                remoteURL: remoteURL,
                key: key,
                range: range,
                policy: policy
            )
        }

        tasksLock.lock()
        runningTasks[ObjectIdentifier(urlSchemeTask)] = (state, work)
        tasksLock.unlock()

        // 极短路径下任务可能在登记前就跑完：补一次清理，避免字典里留下死条目。
        if state.isCancelled {
            removeTask(urlSchemeTask)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        tasksLock.lock()
        let entry = runningTasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))
        tasksLock.unlock()
        entry?.state.cancel()
        entry?.work.cancel()
    }

    // MARK: - 核心流程

    private func serve(
        state: AnyunSchemeTaskState,
        task: WKURLSchemeTask,
        remoteURL: URL,
        key: String,
        range: (start: Int, end: Int?)?,
        policy: AnyunCachePolicy
    ) async {
        defer { removeTask(task) }

        let start = range?.start ?? 0
        let end = range?.end

        // 1) 命中：立即回；顺带判断是否需要后台 revalidate。
        if let entry = await disk.lookup(key: key) {
            if let read = await disk.readRange(key: key, start: start, end: end) {
                deliver(state: state, task: task, read: read, contentType: contentType(for: entry))
                let age = Date().timeIntervalSince1970 - entry.createdAt
                if age > Double(policy.mediaRevalidateSeconds) {
                    scheduleRevalidate(key: key, entry: entry, remoteURL: remoteURL)
                }
                return
            }
            // 索引有、文件没了：当作未命中，继续走网络（不清索引，交给淘汰逻辑收尾）。
        }

        // 2) 未命中：整段拉取（不透传 Range，保证落盘的是完整文件），成功后写盘再按需切段服务。
        let network = self.network
        do {
            _ = try await disk.downloadOnce(key: key, kind: .media) {
                let response = try await network.get(remoteURL)
                guard response.status == 200, !response.data.isEmpty else {
                    throw AnyunCacheError.http(response.status)
                }
                return AnyunDownloadedPayload(
                    data: response.data,
                    etag: response.etag,
                    lastModified: response.lastModified,
                    contentType: response.contentType
                )
            }

            guard !state.isCancelled else { return }
            guard let read = await disk.readRange(key: key, start: start, end: end) else {
                fail(state: state, task: task, error: AnyunCacheError.http(0))
                return
            }
            deliver(state: state, task: task, read: read, contentType: AnyunCacheConstants.defaultMediaContentType)
        } catch {
            // 离线/失败：绝不删除既有缓存，只把这个 task 判失败。
            guard !state.isCancelled else { return }
            fail(state: state, task: task, error: error)
        }
    }

    /// 后台条件请求：304 只刷新 age，200 覆盖内容，失败一律保留缓存。
    private func scheduleRevalidate(key: String, entry: AnyunCacheEntry, remoteURL: URL) {
        let disk = self.disk
        let network = self.network
        Task.detached(priority: .utility) {
            do {
                let response = try await network.get(
                    remoteURL,
                    etag: entry.etag,
                    lastModified: entry.lastModified
                )
                if response.isNotModified {
                    await disk.markRevalidated(key: key)
                } else if response.status == 200, !response.data.isEmpty {
                    _ = try? await disk.store(
                        key: key,
                        kind: .media,
                        payload: AnyunDownloadedPayload(
                            data: response.data,
                            etag: response.etag,
                            lastModified: response.lastModified,
                            contentType: response.contentType
                        )
                    )
                }
            } catch {
                // 失败保留旧缓存（SWR 语义）。
            }
        }
    }

    // MARK: - 投递

    private func contentType(for entry: AnyunCacheEntry) -> String {
        if let stored = entry.contentType, !stored.isEmpty {
            return stored
        }
        return AnyunCacheConstants.defaultMediaContentType
    }

    private func deliver(state: AnyunSchemeTaskState, task: WKURLSchemeTask, read: AnyunRangeRead, contentType: String) {
        guard let url = task.request.url else {
            fail(state: state, task: task, error: AnyunCacheError.badURL)
            return
        }

        var headers: [String: String] = [
            "Content-Type": contentType,
            "Content-Length": "\(read.data.count)",
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store"
        ]
        let status: Int
        if read.isPartial {
            status = 206
            headers["Content-Range"] = "bytes \(read.start)-\(read.endInclusive)/\(read.totalBytes)"
        } else {
            status = 200
        }

        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            fail(state: state, task: task, error: AnyunCacheError.badURL)
            return
        }

        // WebKit 的 scheme task 回调必须在主线程；而 start/stop 也在主线程，
        // 所以整段投递作为一个主线程块原子完成，check 一次即可避免「stop 后又回调」。
        AnyunCacheSchemeHandler.onMain {
            guard state.claimDelivery() else { return }
            task.didReceive(response)
            if !read.data.isEmpty {
                task.didReceive(read.data)
            }
            task.didFinish()
            state.markFinished()
        }
    }

    private func fail(state: AnyunSchemeTaskState, task: WKURLSchemeTask, error: Error) {
        let nsError: NSError
        if let cacheError = error as? AnyunCacheError {
            nsError = cacheError.nsError
        } else {
            let underlying = error as NSError
            nsError = NSError(domain: AnyunCacheError.domain, code: underlying.code, userInfo: [
                NSLocalizedDescriptionKey: underlying.localizedDescription
            ])
        }
        AnyunCacheSchemeHandler.onMain {
            guard state.claimDelivery() else { return }
            task.didFailWithError(nsError)
            state.markFinished()
        }
    }

    /// 主线程是 scheme task 回调的唯一安全通道。
    static func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
        }
    }

    private func removeTask(_ task: WKURLSchemeTask) {
        tasksLock.lock()
        runningTasks.removeValue(forKey: ObjectIdentifier(task))
        tasksLock.unlock()
    }

    // MARK: - 解析

    /// `anyun-cache://media?u=<percent-encoded https URL>` → 原始 https URL。其余一律 nil（badURL）。
    static func remoteURL(from url: URL) -> URL? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        guard components.scheme?.lowercased() == AnyunCacheConstants.scheme else { return nil }
        guard components.host?.lowercased() == AnyunCacheConstants.mediaHost else { return nil }
        let items = components.queryItems ?? []
        guard let raw = items.first(where: { $0.name == AnyunCacheConstants.mediaQueryKey })?.value, !raw.isEmpty else {
            return nil
        }
        guard let remote = URL(string: raw) else { return nil }
        guard remote.scheme?.lowercased() == "https" else { return nil }
        return remote
    }

    /// `bytes=100-200` / `bytes=100-`；多段或后缀范围（`bytes=-500`，需要总长）按整段处理。
    static func parseRangeHeader(_ header: String?) -> (start: Int, end: Int?)? {
        guard let header = header?.trimmingCharacters(in: .whitespacesAndNewlines), !header.isEmpty else { return nil }
        guard header.lowercased().hasPrefix("bytes=") else { return nil }
        let spec = String(header.dropFirst("bytes=".count))
        if spec.contains(",") { return nil }
        let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let startPart = String(parts[0]).trimmingCharacters(in: .whitespaces)
        let endPart = String(parts[1]).trimmingCharacters(in: .whitespaces)
        if startPart.isEmpty { return nil }
        guard let start = Int(startPart), start >= 0 else { return nil }
        if endPart.isEmpty { return (start, nil) }
        guard let end = Int(endPart), end >= start else { return nil }
        return (start, end)
    }
}