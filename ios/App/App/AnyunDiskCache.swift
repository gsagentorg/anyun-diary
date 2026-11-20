//
//  AnyunDiskCache.swift
//  App
//
//  UNVERIFIED: 未在 macOS/Xcode 编译，未真机验证
//
//  磁盘缓存（actor，串行化）：目录 `Caches/anyun-cache/`，数据文件 `<sha256>.bin`，
//  元数据集中在 `index.json`（原子写），按 maxBytes/maxEntries 做 LRU 淘汰，跳过 in-flight 条目。
//

import Foundation
import CryptoKit

/// 原始 URL 的 SHA-256（十六进制小写）。插件与 scheme handler 必须用同一个键。
enum AnyunCacheKey {
    static func hash(_ source: String) -> String {
        let digest = SHA256.hash(data: Data(source.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// 索引条目。字段与 `docs/ios-audio-cache.md` 的 index.json 契约一一对应。
/// `createdAt` 是“内容确认时间”：304 revalidate 时刷新，因此 age = now - createdAt。
struct AnyunCacheEntry: Codable, Sendable, Equatable {
    let key: String
    var kind: AnyunCacheKind
    var bytes: Int
    var createdAt: Double
    var lastAccess: Double
    var etag: String?
    var lastModified: String?
    var contentType: String?
}

/// index.json 的整体形态（版本号留在文件里，方便将来迁移）。
struct AnyunCacheIndexFile: Codable {
    var version: Int
    var entries: [AnyunCacheEntry]
}

/// 一次下载的产物（尚未落盘）。
struct AnyunDownloadedPayload: Sendable {
    let data: Data
    let etag: String?
    let lastModified: String?
    let contentType: String?
}

/// 一次分段读取的结果（SchemeHandler 据此拼 200 / 206）。
struct AnyunRangeRead: Sendable {
    let data: Data
    let start: Int
    let endInclusive: Int
    let totalBytes: Int

    /// 是否只读了文件的一部分（决定 206 + Content-Range）。
    var isPartial: Bool {
        return !(start == 0 && endInclusive == totalBytes - 1)
    }
}

struct AnyunCacheStats: Sendable {
    let bytes: Int
    let entries: Int
    let mediaEntries: Int
    let jsonEntries: Int
    let maxBytes: Int
    let cacheDir: String
}

struct AnyunClearResult: Sendable {
    let freedBytes: Int
    let entries: Int
}

/// 磁盘缓存本体。所有文件操作在 actor 内串行执行，避免多线程同时改 index.json。
actor AnyunDiskCache {
    static let shared = AnyunDiskCache()

    private let directory: URL
    private let indexPath: URL
    private let policyProvider: @Sendable () -> AnyunCachePolicy

    private var entries: [String: AnyunCacheEntry] = [:]
    private var indexLoaded = false

    /// 同一 key 的并发下载合并：第一个负责下载，其余 await 同一个 Task 的结果。
    private var inFlight: [String: Task<AnyunCacheEntry, Error>] = [:]

    init(
        directoryName: String = AnyunCacheConstants.cacheDirectoryName,
        policyProvider: @escaping @Sendable () -> AnyunCachePolicy = { AnyunCachePolicyStore.shared.load() }
    ) {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        self.directory = base.appendingPathComponent(directoryName, isDirectory: true)
        self.indexPath = self.directory.appendingPathComponent(AnyunCacheConstants.indexFileName, isDirectory: false)
        self.policyProvider = policyProvider
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true, attributes: nil)
    }

    // MARK: - 路径

    func fileURL(forKey key: String) -> URL {
        return directory.appendingPathComponent("\(key).\(AnyunCacheConstants.binaryExtension)", isDirectory: false)
    }

    /// scheme handler 需要把“是否命中”与“字节”分开问，这里提供入口。
    func exists(key: String) -> Bool {
        ensureIndexLoaded()
        return entries[key] != nil
    }

    // MARK: - 读

    /// 命中即 touch `lastAccess`（节流写盘），返回条目快照。
    func lookup(key: String) -> AnyunCacheEntry? {
        ensureIndexLoaded()
        guard var entry = entries[key] else { return nil }
        let now = Date().timeIntervalSince1970
        if now - entry.lastAccess >= AnyunCacheConstants.lastAccessPersistInterval {
            entry.lastAccess = now
            entries[key] = entry
            persistIndex()
        }
        return entry
    }

    /// 整段读取；条目不存在或文件丢失返回 nil（调用方自行回退网络）。
    func read(key: String) -> Data? {
        ensureIndexLoaded()
        guard entries[key] != nil else { return nil }
        return try? Data(contentsOf: fileURL(forKey: key), options: .mappedIfSafe)
    }

    /// 分段读取（`Range: bytes=start-end?`）。命中时 touch，返回切片与总长。
    func readRange(key: String, start: Int, end: Int?) -> AnyunRangeRead? {
        ensureIndexLoaded()
        guard var entry = entries[key] else { return nil }

        let url = fileURL(forKey: key)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber else {
            return nil
        }
        let total = size.intValue
        guard total > 0 else { return nil }

        let safeStart = max(0, min(start, total - 1))
        let requestedEnd = end.map { min($0, total - 1) } ?? (total - 1)
        let safeEnd = max(safeStart, requestedEnd)

        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        try? handle.seek(toOffset: UInt64(safeStart))
        let data = (try? handle.read(upToCount: safeEnd - safeStart + 1)) ?? Data()

        let now = Date().timeIntervalSince1970
        if now - entry.lastAccess >= AnyunCacheConstants.lastAccessPersistInterval {
            entry.lastAccess = now
            entries[key] = entry
            persistIndex()
        }
        return AnyunRangeRead(data: data, start: safeStart, endInclusive: safeEnd, totalBytes: total)
    }

    // MARK: - 写

    /// 写盘：文件原子写 + 更新索引 + LRU 淘汰 + 索引原子写。
    @discardableResult
    func store(key: String, kind: AnyunCacheKind, payload: AnyunDownloadedPayload) throws -> AnyunCacheEntry {
        ensureIndexLoaded()
        ensureDirectory()

        let target = fileURL(forKey: key)
        try payload.data.write(to: target, options: .atomic)

        let now = Date().timeIntervalSince1970
        let previous = entries[key]
        let entry = AnyunCacheEntry(
            key: key,
            kind: kind,
            bytes: payload.data.count,
            createdAt: now,
            lastAccess: now,
            etag: payload.etag ?? previous?.etag,
            lastModified: payload.lastModified ?? previous?.lastModified,
            contentType: payload.contentType ?? previous?.contentType
        )
        entries[key] = entry
        evict(protecting: key)
        persistIndex()
        return entry
    }

    /// 索引（data.json）专用入口：与媒体共用磁盘，但 kind 记为 json。
    @discardableResult
    func storeJSON(key: String, data: Data, etag: String?, lastModified: String?, contentType: String?) throws -> AnyunCacheEntry {
        let payload = AnyunDownloadedPayload(data: data, etag: etag, lastModified: lastModified, contentType: contentType)
        return try store(key: key, kind: .json, payload: payload)
    }

    /// 304：只更新“内容确认时间”（age 归零），不动内容与 etag。
    func markRevalidated(key: String) {
        ensureIndexLoaded()
        guard var entry = entries[key] else { return }
        let now = Date().timeIntervalSince1970
        entry.createdAt = now
        entry.lastAccess = now
        entries[key] = entry
        persistIndex()
    }

    /// 同 key 并发合并：第一个调用负责执行 `operation`，其余调用 await 同一个结果。
    /// `operation` 必须在 actor 之外完成网络 IO（不得回调本 actor，避免重入陷阱）。
    /// 发起方被取消（WebKit stop 掉 scheme task）时连带取消下载，避免白耗流量。
    func downloadOnce(
        key: String,
        kind: AnyunCacheKind,
        operation: @escaping @Sendable () async throws -> AnyunDownloadedPayload
    ) async throws -> AnyunCacheEntry {
        ensureIndexLoaded()
        if let existing = inFlight[key] {
            return try await existing.value
        }

        let worker = Task.detached(priority: .utility) {
            let payload = try await operation()
            return try await self.store(key: key, kind: kind, payload: payload)
        }
        inFlight[key] = worker
        defer { inFlight[key] = nil }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: {
            worker.cancel()
        }
    }

    // MARK: - 清理与统计

    func clear(scope: String) -> AnyunClearResult {
        ensureIndexLoaded()
        let normalized = scope.lowercased()
        let matchesAll = normalized.isEmpty || normalized == "all"
        let targets = entries.values.filter { entry in
            if matchesAll { return true }
            if normalized == "media" { return entry.kind == .media }
            if normalized == "json" { return entry.kind == .json }
            return false
        }

        var freed = 0
        var removed = 0
        for entry in targets {
            try? FileManager.default.removeItem(at: fileURL(forKey: entry.key))
            freed += entry.bytes
            removed += 1
            entries.removeValue(forKey: entry.key)
        }
        persistIndex()
        return AnyunClearResult(freedBytes: freed, entries: removed)
    }

    func stats() -> AnyunCacheStats {
        ensureIndexLoaded()
        var bytes = 0
        var media = 0
        var json = 0
        for entry in entries.values {
            bytes += entry.bytes
            if entry.kind == .media {
                media += 1
            } else {
                json += 1
            }
        }
        return AnyunCacheStats(
            bytes: bytes,
            entries: entries.count,
            mediaEntries: media,
            jsonEntries: json,
            maxBytes: policyProvider().maxBytes,
            cacheDir: directory.path
        )
    }

    // MARK: - 索引与淘汰

    private func ensureDirectory() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: nil)
    }

    private func ensureIndexLoaded() {
        guard !indexLoaded else { return }
        indexLoaded = true
        ensureDirectory()
        guard let data = try? Data(contentsOf: indexPath) else {
            entries = [:]
            return
        }
        guard let decoded = try? JSONDecoder().decode(AnyunCacheIndexFile.self, from: data) else {
            entries = [:]
            return
        }
        var table: [String: AnyunCacheEntry] = [:]
        for entry in decoded.entries {
            // 文件被系统清掉时索引会变脏：以文件存在为准。
            if FileManager.default.fileExists(atPath: fileURL(forKey: entry.key).path) {
                table[entry.key] = entry
            }
        }
        entries = table
    }

    /// index.json 原子写：先写临时文件，再 replaceItemAt 落位。
    private func persistIndex() {
        ensureDirectory()
        let payload = AnyunCacheIndexFile(version: 1, entries: entries.values.sorted { $0.key < $1.key })
        guard let data = try? JSONEncoder().encode(payload) else { return }

        let temp = directory.appendingPathComponent("index.json.tmp", isDirectory: false)
        guard (try? data.write(to: temp, options: .atomic)) != nil else { return }

        let manager = FileManager.default
        if manager.fileExists(atPath: indexPath.path) {
            _ = try? manager.replaceItemAt(indexPath, withItemAt: temp, backupItemName: nil, options: [])
        } else {
            try? manager.moveItem(at: temp, to: indexPath)
        }
    }

    /// LRU：从最久未用开始删，跳过保护项与正在下载的条目。
    private func evict(protecting protectedKey: String?) {
        let policy = policyProvider()
        var total = 0
        for entry in entries.values {
            total += entry.bytes
        }
        var count = entries.count
        guard total > policy.maxBytes || count > policy.maxEntries else { return }

        let candidates = entries.values
            .filter { $0.key != protectedKey && inFlight[$0.key] == nil }
            .sorted { $0.lastAccess < $1.lastAccess }

        for candidate in candidates {
            if total <= policy.maxBytes && count <= policy.maxEntries { break }
            try? FileManager.default.removeItem(at: fileURL(forKey: candidate.key))
            entries.removeValue(forKey: candidate.key)
            total -= candidate.bytes
            count -= 1
        }
    }
}