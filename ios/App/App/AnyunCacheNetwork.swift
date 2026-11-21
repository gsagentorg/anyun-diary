//
//  AnyunCacheNetwork.swift
//  App
//
//  UNVERIFIED: 未在 macOS/Xcode 编译，未真机验证
//
//  极薄的 URLSession 封装：GET + Range 透传 + 条件请求（If-None-Match / If-Modified-Since），
//  10 秒超时，返回 status/data/etag/lastModified/contentType 以及是否 304。
//  不在这里做任何缓存判断 —— 语义全部在 SchemeHandler / Plugin / DiskCache 里。
//
//  v2 新增 `downloadFile`：AVPlayer 预取专用的**流式**下载。
//  - 逐块写临时文件，内存占用恒定（不再整段缓冲）；
//  - Content-Length 声明或实际累计字节超过 maxBytes 立即终止（真正有界）；
//  - 稳定源 URL 的 307 → 签名目标由 URLSession 默认重定向策略自动跟随：签名地址只存在于
//    这次内存中的传输过程，绝不返回给调用方、绝不持久化、绝不进日志；
//  - idle/资源双超时 + Task 取消桥接（挂死的直播弱网有界退场）；
//  - 任何失败/取消/超限路径都自行删除临时文件 —— 磁盘上不会留下伪装成完整的残片。
//

import Foundation

/// 一次 HTTP 往返的结果。
struct AnyunHTTPResponse {
    let status: Int
    let data: Data
    let etag: String?
    let lastModified: String?
    let contentType: String?

    var isNotModified: Bool {
        return status == 304
    }

    var isSuccess: Bool {
        return status >= 200 && status < 300
    }
}

/// 一次流式文件下载的成果（已完整落在临时路径，等待 DiskCache 校验+改名接管）。
struct AnyunDownloadedFile: Sendable {
    let fileURL: URL
    let bytes: Int
    let etag: String?
    let lastModified: String?
    let contentType: String?
}

final class AnyunCacheNetwork {
    static let shared = AnyunCacheNetwork()

    private let session: URLSession
    private let timeout: TimeInterval

    /// 默认 10 秒（契约：索引网络请求 10 s 超时）。
    init(timeout: TimeInterval = 10) {
        self.timeout = timeout
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout * 3
        // 自己就是缓存层，不能再让 URLSession 私自缓存一份。
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        self.session = URLSession(configuration: configuration)
    }

    /// 执行一次 GET。
    /// - Parameters:
    ///   - rangeHeader: 原样透传的 `Range` 头（仅音频分段需要；缓存未命中时不透传，直接拉全量）。
    ///   - etag / lastModified: 命中缓存后做条件 revalidate。
    func get(
        _ url: URL,
        rangeHeader: String? = nil,
        etag: String? = nil,
        lastModified: String? = nil
    ) async throws -> AnyunHTTPResponse {
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "https" || scheme == "http" else {
            throw AnyunCacheError.badURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let rangeHeader = rangeHeader, !rangeHeader.isEmpty {
            request.setValue(rangeHeader, forHTTPHeaderField: "Range")
        }
        if let etag = etag, !etag.isEmpty {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        if let lastModified = lastModified, !lastModified.isEmpty {
            request.setValue(lastModified, forHTTPHeaderField: "If-Modified-Since")
        }

        if Task.isCancelled {
            throw AnyunCacheError.cancelled
        }

        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw AnyunCacheError.cancelled
        } catch is CancellationError {
            throw AnyunCacheError.cancelled
        }

        let data = result.0
        guard let http = result.1 as? HTTPURLResponse else {
            throw AnyunCacheError.http(0)
        }
        let headers = http.allHeaderFields
        return AnyunHTTPResponse(
            status: http.statusCode,
            data: data,
            etag: AnyunCacheNetwork.headerValue(headers, "Etag"),
            lastModified: AnyunCacheNetwork.headerValue(headers, "Last-Modified"),
            contentType: AnyunCacheNetwork.headerValue(headers, "Content-Type")
        )
    }

    /// 流式下载整个资源到 `destination`（调用方提供的 incoming/ 临时路径）。
    /// 完成后由 `AnyunDiskCache.downloadFileOnce` 的 commit 接管改名/清理责任；
    /// 本方法抛错时已保证删除自己写出来的临时文件。
    func downloadFile(
        _ url: URL,
        to destination: URL,
        maxBytes: Int,
        idleTimeout: TimeInterval = AnyunCacheNetwork.mediaIdleTimeout,
        resourceTimeout: TimeInterval = AnyunCacheNetwork.mediaResourceTimeout
    ) async throws -> AnyunDownloadedFile {
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "https" || scheme == "http" else {
            throw AnyunCacheError.badURL
        }
        guard maxBytes > 0 else {
            throw AnyunCacheOversizeError.oversize
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = idleTimeout
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")

        let manager = FileManager.default
        try? manager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
        try? manager.removeItem(at: destination)

        if Task.isCancelled {
            throw AnyunCacheError.cancelled
        }

        let box = AnyunTaskBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<AnyunDownloadedFile, Error>) in
                let configuration = URLSessionConfiguration.ephemeral
                configuration.timeoutIntervalForRequest = idleTimeout
                configuration.timeoutIntervalForResource = resourceTimeout
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                configuration.urlCache = nil
                let sink = AnyunFileSink(destination: destination, maxBytes: maxBytes, continuation: continuation)
                let session = URLSession(configuration: configuration, delegate: sink, delegateQueue: nil)
                sink.attach(session)
                let task = session.dataTask(with: request)
                box.adopt(task)
                task.resume()
            }
        } onCancel: {
            box.cancel()
        }
    }

    /// 媒体文件下载的双超时：idle 30 s（没有任何字节的静默即断），资源 10 min 封顶（防挂死）。
    static let mediaIdleTimeout: TimeInterval = 30
    static let mediaResourceTimeout: TimeInterval = 600

    /// HTTP 头大小写不敏感。
    private static func headerValue(_ headers: [AnyHashable: Any], _ name: String) -> String? {
        for (key, value) in headers {
            guard let key = key as? String else { continue }
            if key.caseInsensitiveCompare(name) == .orderedSame {
                return value as? String
            }
        }
        return nil
    }
}

/// Task 引用盒：`onCancel` 可能在 task 创建完成前触发，adopt 时补一刀。
final class AnyunTaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var cancelRequested = false

    func adopt(_ newTask: URLSessionTask) {
        lock.lock()
        task = newTask
        let pending = cancelRequested
        lock.unlock()
        if pending { newTask.cancel() }
    }

    func cancel() {
        lock.lock()
        cancelRequested = true
        let target = task
        lock.unlock()
        target?.cancel()
    }
}

/// 流式落盘 delegate。所有 delegate 回调都在 session 的串行队列上；
/// continuation 恰好恢复一次（`resumed` 闸门）。
private final class AnyunFileSink: NSObject, URLSessionDataDelegate {
    private let destination: URL
    private let maxBytes: Int
    private let continuation: CheckedContinuation<AnyunDownloadedFile, Error>

    private var sessionRef: URLSession?
    private var expectedBytes: Int64 = -1
    private var handle: FileHandle?
    private var bytes = 0
    private var headers: [AnyHashable: Any] = [:]
    private var failure: Error?
    private var resumed = false

    init(destination: URL, maxBytes: Int, continuation: CheckedContinuation<AnyunDownloadedFile, Error>) {
        self.destination = destination
        self.maxBytes = maxBytes
        self.continuation = continuation
    }

    func attach(_ session: URLSession) {
        sessionRef = session
    }

    private func noteFailure(_ error: Error) {
        if failure == nil { failure = error }
    }

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            noteFailure(AnyunCacheError.http(0))
            dataTask.cancel()
            completionHandler(.cancel)
            return
        }
        guard http.statusCode == 200, http.value(forHTTPHeaderField: "Content-Range") == nil else {
            noteFailure(AnyunCacheError.http(http.statusCode))
            completionHandler(.cancel)
            return
        }
        // 稳定地址经 307 到达签名目标；此处只见最终响应头。
        headers = http.allHeaderFields
        let declared = http.expectedContentLength
        expectedBytes = declared
        if declared > Int64(maxBytes) {
            noteFailure(AnyunCacheOversizeError.oversize)
            completionHandler(.cancel)
            return
        }
        do {
            guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
                throw AnyunDiskCacheFailure.ioFailure
            }
            let handle = try FileHandle(forWritingTo: destination)
            self.handle = handle
        } catch {
            noteFailure(AnyunDiskCacheFailure.ioFailure)
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil, let handle = handle else { return }
        bytes += data.count
        if bytes > maxBytes {
            noteFailure(AnyunCacheOversizeError.oversize)
            dataTask.cancel()
            return
        }
        do {
            try handle.write(contentsOf: data)
        } catch {
            noteFailure(AnyunDiskCacheFailure.ioFailure)
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        do { try handle?.close() } catch { noteFailure(AnyunDiskCacheFailure.ioFailure) }
        handle = nil
        if expectedBytes >= 0, Int64(bytes) != expectedBytes {
            noteFailure(AnyunDiskCacheFailure.incompleteFile)
        }

        var thrown: Error? = failure
        if thrown == nil, let error = error as NSError? {
            if error.code == NSURLErrorCancelled {
                thrown = AnyunCacheError.cancelled
            } else {
                thrown = error
            }
        }
        sessionRef?.finishTasksAndInvalidate()
        sessionRef = nil

        guard !resumed else { return }
        if let thrown = thrown {
            try? FileManager.default.removeItem(at: destination)
            resumed = true
            continuation.resume(throwing: thrown)
            return
        }
        guard bytes > 0 else {
            try? FileManager.default.removeItem(at: destination)
            resumed = true
            continuation.resume(throwing: AnyunDiskCacheFailure.emptyPayload)
            return
        }
        let result = AnyunDownloadedFile(
            fileURL: destination,
            bytes: bytes,
            etag: AnyunCacheNetwork.headerValuePublic(headers, "Etag"),
            lastModified: AnyunCacheNetwork.headerValuePublic(headers, "Last-Modified"),
            contentType: AnyunCacheNetwork.headerValuePublic(headers, "Content-Type")
        )
        resumed = true
        continuation.resume(returning: result)
    }
}

extension AnyunCacheNetwork {
    /// 供 sink 复用的头大小写不敏感读取。
    static func headerValuePublic(_ headers: [AnyHashable: Any], _ name: String) -> String? {
        for (key, value) in headers {
            guard let key = key as? String else { continue }
            if key.caseInsensitiveCompare(name) == .orderedSame {
                return value as? String
            }
        }
        return nil
    }
}
