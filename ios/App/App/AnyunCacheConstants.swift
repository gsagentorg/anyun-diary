//
//  AnyunCacheConstants.swift
//  App
//
//  UNVERIFIED: 未在 macOS/Xcode 编译，未真机验证
//
//  契约来源：docs/ios-audio-cache.md（scheme / host / 策略默认值与夹取范围 / 错误码）。
//  本文件不依赖 Capacitor，可被 SchemeHandler、DiskCache、Plugin 共用。
//

import Foundation

/// 原生缓存层的固定字面量。改动这些值等于改 JS ⇄ Swift 契约，必须同步 `docs/ios-audio-cache.md`
/// 与网页侧 `src/lib/native-cache.ts`。
enum AnyunCacheConstants {
    /// 自定义 scheme：`anyun-cache://media?u=<percent-encoded https URL>`
    static let scheme = "anyun-cache"
    /// scheme 里唯一允许的 host（音频）。
    static let mediaHost = "media"
    /// 查询参数名：原始 https URL（百分号编码）。
    static let mediaQueryKey = "u"

    /// 策略持久化键（UserDefaults，值为 JSON）。
    static let policyDefaultsKey = "anyun.cache.policy.v1"

    /// 缓存目录名（落在 `Caches/` 下，系统可清理，符合“缓存”语义）。
    static let cacheDirectoryName = "anyun-cache"
    /// 元数据文件名（集中索引）。
    static let indexFileName = "index.json"
    /// 数据文件扩展名：`<hash>.bin`。
    static let binaryExtension = "bin"

    /// 音频命中时默认 Content-Type（与网页侧 `audio/ogg` 一致）。
    static let defaultMediaContentType = "audio/ogg"

    /// `lastAccess` 落盘节流：命中时并非每次都要重写 index.json。
    static let lastAccessPersistInterval: TimeInterval = 60
}

/// 缓存条目的种类。索引（data.json）与音频走同一套磁盘缓存，但 revalidate 策略不同。
enum AnyunCacheKind: String, Codable, Sendable {
    case media
    case json
}

/// 缓存策略。默认值与夹取范围严格照 `docs/ios-audio-cache.md` 的契约表。
struct AnyunCachePolicy: Codable, Equatable, Sendable {
    /// 512 MiB
    static let defaultMaxBytes = 536870912
    /// 4000 条
    static let defaultMaxEntries = 4000
    /// 7 天：音频不可变，宽松 revalidate
    static let defaultMediaRevalidateSeconds = 604800
    /// 60 秒：索引可变，窗口内直接命中
    static let defaultJsonStaleSeconds = 60

    static let maxBytesRange = 16777216...4294967296
    static let maxEntriesRange = 64...20000
    static let mediaRevalidateSecondsRange = 3600...2592000
    static let jsonStaleSecondsRange = 5...3600

    var maxBytes: Int
    var maxEntries: Int
    var mediaRevalidateSeconds: Int
    var jsonStaleSeconds: Int

    static let `default` = AnyunCachePolicy(
        maxBytes: AnyunCachePolicy.defaultMaxBytes,
        maxEntries: AnyunCachePolicy.defaultMaxEntries,
        mediaRevalidateSeconds: AnyunCachePolicy.defaultMediaRevalidateSeconds,
        jsonStaleSeconds: AnyunCachePolicy.defaultJsonStaleSeconds
    )

    /// 夹取到契约允许的区间；任何越界/NaN 输入都退化为边界值。
    func clamped() -> AnyunCachePolicy {
        return AnyunCachePolicy(
            maxBytes: AnyunCachePolicy.clamp(maxBytes, lower: AnyunCachePolicy.maxBytesRange.lowerBound, upper: AnyunCachePolicy.maxBytesRange.upperBound),
            maxEntries: AnyunCachePolicy.clamp(maxEntries, lower: AnyunCachePolicy.maxEntriesRange.lowerBound, upper: AnyunCachePolicy.maxEntriesRange.upperBound),
            mediaRevalidateSeconds: AnyunCachePolicy.clamp(mediaRevalidateSeconds, lower: AnyunCachePolicy.mediaRevalidateSecondsRange.lowerBound, upper: AnyunCachePolicy.mediaRevalidateSecondsRange.upperBound),
            jsonStaleSeconds: AnyunCachePolicy.clamp(jsonStaleSeconds, lower: AnyunCachePolicy.jsonStaleSecondsRange.lowerBound, upper: AnyunCachePolicy.jsonStaleSecondsRange.upperBound)
        )
    }

    /// 供插件返回值使用的字典（字段名与契约一致）。
    var dictionaryRepresentation: [String: Any] {
        return [
            "maxBytes": maxBytes,
            "maxEntries": maxEntries,
            "mediaRevalidateSeconds": mediaRevalidateSeconds,
            "jsonStaleSeconds": jsonStaleSeconds
        ]
    }

    /// 从 JS 传入的对象构造策略：缺字段取默认值，最后统一夹取。
    static func from(dictionary: [String: Any]?) -> AnyunCachePolicy {
        guard let dictionary = dictionary else { return AnyunCachePolicy.default }
        let base = AnyunCachePolicy.default
        let resolved = AnyunCachePolicy(
            maxBytes: AnyunCachePolicy.intValue(dictionary["maxBytes"]) ?? base.maxBytes,
            maxEntries: AnyunCachePolicy.intValue(dictionary["maxEntries"]) ?? base.maxEntries,
            mediaRevalidateSeconds: AnyunCachePolicy.intValue(dictionary["mediaRevalidateSeconds"]) ?? base.mediaRevalidateSeconds,
            jsonStaleSeconds: AnyunCachePolicy.intValue(dictionary["jsonStaleSeconds"]) ?? base.jsonStaleSeconds
        )
        return resolved.clamped()
    }

    static func clamp(_ value: Int, lower: Int, upper: Int) -> Int {
        if value < lower { return lower }
        if value > upper { return upper }
        return value
    }

    /// JS 数字经 Capacitor 桥接后可能是 Int / Double / Float / NSNumber / String，统一取值。
    static func intValue(_ any: Any?) -> Int? {
        guard let any = any else { return nil }
        switch any {
        case let value as Int:
            return value
        case let value as Double:
            if value.isNaN || value.isInfinite { return nil }
            return Int(value.rounded())
        case let value as Float:
            if value.isNaN || value.isInfinite { return nil }
            return Int(value.rounded())
        case let value as NSNumber:
            return value.intValue
        case let value as String:
            return Int(value)
        default:
            return nil
        }
    }
}

/// 策略的 UserDefaults 持久化（键 `anyun.cache.policy.v1`，值为 JSON）。
final class AnyunCachePolicyStore {
    static let shared = AnyunCachePolicyStore()

    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = UserDefaults.standard, key: String = AnyunCacheConstants.policyDefaultsKey) {
        self.defaults = defaults
        self.key = key
    }

    /// 读盘并夹取；没有落盘值或解不出来时返回默认策略。
    func load() -> AnyunCachePolicy {
        return loadIfPresent() ?? AnyunCachePolicy.default
    }

    /// 仅当确实有合法落盘值时返回（用于 configure 的幂等判断）。
    func loadIfPresent() -> AnyunCachePolicy? {
        guard let data = defaults.data(forKey: key) else { return nil }
        guard let decoded = try? JSONDecoder().decode(AnyunCachePolicy.self, from: data) else { return nil }
        return decoded.clamped()
    }

    /// 夹取后落盘，返回真正生效的策略。
    @discardableResult
    func save(_ policy: AnyunCachePolicy) -> AnyunCachePolicy {
        let clamped = policy.clamped()
        if let data = try? JSONEncoder().encode(clamped) {
            defaults.set(data, forKey: key)
        }
        return clamped
    }
}

/// 原生缓存的错误。domain 固定为 `AnyunCacheError`；`didFailWithError` 需要 NSError 形态。
enum AnyunCacheError: Error {
    case unavailableOffline
    case badURL
    case http(Int)
    case cancelled

    static let domain = "AnyunCacheError"

    /// 稳定的机器可读码（同时用于插件 reject 的 code）。
    var code: String {
        switch self {
        case .unavailableOffline:
            return "UNAVAILABLE"
        case .badURL:
            return "BAD_URL"
        case .http:
            return "HTTP_ERROR"
        case .cancelled:
            return "CANCELLED"
        }
    }

    var message: String {
        switch self {
        case .unavailableOffline:
            return "离线且无缓存"
        case .badURL:
            return "链接无效或不是 https"
        case .http(let status):
            return "网络返回 \(status)"
        case .cancelled:
            return "请求已取消"
        }
    }

    var nsCode: Int {
        switch self {
        case .unavailableOffline:
            return -1
        case .badURL:
            return -2
        case .http(let status):
            return status
        case .cancelled:
            return NSURLErrorCancelled
        }
    }

    var nsError: NSError {
        return NSError(domain: AnyunCacheError.domain, code: nsCode, userInfo: [
            NSLocalizedDescriptionKey: message,
            "anyunCode": code
        ])
    }
}

/// 下载/解析阶段用到的内部错误（不暴露给 JS）。
enum AnyunCachePayloadError: Error {
    case invalidJSON
}
