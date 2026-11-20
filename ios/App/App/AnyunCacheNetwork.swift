//
//  AnyunCacheNetwork.swift
//  App
//
//  UNVERIFIED: 未在 macOS/Xcode 编译，未真机验证
//
//  极薄的 URLSession 封装：GET + Range 透传 + 条件请求（If-None-Match / If-Modified-Since），
//  10 秒超时，返回 status/data/etag/lastModified/contentType 以及是否 304。
//  不在这里做任何缓存判断 —— 语义全部在 SchemeHandler / Plugin 里。
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