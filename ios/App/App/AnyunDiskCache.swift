//
//  AnyunDiskCache.swift
//  App
//
//  UNVERIFIED: 未在 macOS/Xcode 编译，未真机验证
//
//  磁盘缓存（actor，串行化）：目录 `Caches/anyun-cache/`，数据文件 `<sha256>.bin`，
//  元数据集中在 `index.json`（原子写），按 maxBytes/maxEntries 做 LRU 淘汰，跳过 in-flight 条目。
//
//  播放缓存接线（2026-11-21，接通 AVPlayer 磁盘命中）：
//  - `AnyunCacheLayout` 统一物理布局：`playback/`（AVPlayer 硬链接租约，零拷贝）、
//    `incoming/`（流式下载临时区）；键必须是 64 位小写十六进制，杜绝路径注入。
//  - `downloadOnce` 语义修正：订阅者（含发起方，WebKit stop 是常态）取消**不再杀共享 worker**
//    ——旧实现「发起方取消误杀其他订阅」是已知缺陷；槽位由 worker 自身按 id 校验释放，
//    旧任务不会释放新槽。返回值改为 `AnyunDownloadOutcome`：单曲超过 maxBytes 不落盘、
//    不进索引，返回 transient（只在内存里存活），并进程内标记 skip，不再反复尝试写盘。
//  - 新增 `downloadFileOnce`：预取走「流式写临时文件 → 以真实字节数校验 → 原子改名」，
//    残片/失败/超限一律不进索引，绝不把不完整内容当完整。
//  - `clear` 使 epoch 前进并取消在途下载：过期 worker 的提交被丢弃，清掉的条目不能复活。
//  - 后台 revalidate 的写回走 `store(requireExisting:)`：条目若已被 clear/淘汰则丢弃。
//

import Foundation
import CryptoKit
import Darwin

/// 原始 URL 的 SHA-256（十六进制小写）。插件、播放层与 scheme handler 必须用同一个键。
/// 播放层的键源永远是**稳定源 URL**（队列里的 https 地址）；签名目标只存在于单次内存下载
/// 过程中，绝不作为键、绝不持久化、绝不进日志。
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

/// Actor-issued ownership plus an atomic cached snapshot. Latest begun request per key wins.
/// An older response may still serve its caller, but can never mutate the cache.
struct AnyunJSONRequest: Sendable {
    let key: String
    let id: UUID
    let epoch: Int
    let entry: AnyunCacheEntry?
    let data: Data?
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

/// 下载完成后的去向：已完整落盘，或因超限只能内存暂存（transient）。
enum AnyunDownloadOutcome: Sendable {
    case stored(AnyunCacheEntry)
    case transient(AnyunDownloadedPayload)
}

/// 单曲超过缓存容量（或此前已被判定超限）。内部信号，不直接暴露给 JS。
enum AnyunCacheOversizeError: Error, Sendable {
    case oversize
}

/// 缓存内部失败（不跨桥）。
enum AnyunDiskCacheFailure: Error, Sendable {
    case emptyPayload
    case incompleteFile
    case ioFailure
}

/// 缓存目录物理布局（纯值类型，可在测试里注入临时目录，不依赖 actor）。
struct AnyunCacheLayout: Sendable {
    let root: URL
    /// 播放租约扩展名：Ogg Opus。AVURLAsset 靠“扩展名 + 内容嗅探”确定类型，`.bin` 不保证。
    static let playbackExtension = "ogg"

    var indexFile: URL { root.appendingPathComponent(AnyunCacheConstants.indexFileName, isDirectory: false) }
    var playbackDirectory: URL { root.appendingPathComponent("playback", isDirectory: true) }
    var incomingDirectory: URL { root.appendingPathComponent("incoming", isDirectory: true) }

    func mediaFile(forKey key: String) -> URL {
        return root.appendingPathComponent("\(key).\(AnyunCacheConstants.binaryExtension)", isDirectory: false)
    }

    /// 非法键直接拒绝生成路径（防 path traversal）。
    func playbackLink(forKey key: String) -> URL? {
        guard AnyunCacheLayout.isValidKey(key) else { return nil }
        return playbackDirectory.appendingPathComponent("\(key).\(AnyunCacheLayout.playbackExtension)", isDirectory: false)
    }

    func incomingFile(named name: String) -> URL {
        let safe = name.split(separator: "/").joined(separator: "_")
        return incomingDirectory.appendingPathComponent(safe, isDirectory: false)
    }

    /// 只有 SHA-256 十六进制形态才允许作为文件名。
    static func isValidKey(_ key: String) -> Bool {
        guard key.count == 64 else { return false }
        let hex = CharacterSet(charactersIn: "0123456789abcdef")
        return key.unicodeScalars.allSatisfy { hex.contains($0) }
    }

    static let standard: AnyunCacheLayout = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return AnyunCacheLayout(root: base.appendingPathComponent(AnyunCacheConstants.cacheDirectoryName, isDirectory: true))
    }()
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

    /// 不可变且 Sendable 的目录描述；实际媒体/租约 IO 必须在本 actor。
    nonisolated let layout: AnyunCacheLayout
    private let indexPath: URL
    private let policyProvider: @Sendable () -> AnyunCachePolicy

    private var entries: [String: AnyunCacheEntry] = [:]
    private var indexLoaded = false
    private var lastAccessPersistedAt: Double = 0

    /// 同一 key 的共享下载。worker 自身负责释放槽位（按 id 校验）；
    /// 任何一个订阅者被取消都**不**杀 worker（见文件头语义修正说明）。
    private struct InFlightData {
        let id: UUID
        let epoch: Int
        let kind: AnyunCacheKind
        let task: Task<AnyunDownloadOutcome, Error>
    }
    private struct InFlightFile {
        let id: UUID
        let epoch: Int
        let task: Task<AnyunCacheEntry, Error>
    }
    private var inFlight: [String: InFlightData] = [:]
    private var inFlightFiles: [String: InFlightFile] = [:]
    /// `clear` 使 epoch 前进：此前创建的 worker 提交时一律作废，保证“清掉的不复活”。
    private var epoch = 0
    private var mediaEpoch = 0
    private var jsonEpoch = 0
    private var jsonRequests: [String: UUID] = [:]
    private var recentLeaseKeys: [String] = []
    private var leasesSwept = false
    /// 有界（最多128）超限键记忆；瞬时网络错误不进入此集合。
    /// clear（media/all）会清空该集合，允许策略调整或用户再次清除后重新尝试。
    private var skippedKeys: Set<String> = []
    private var mediaRefreshOwners: [String: UUID] = [:]
    private var mediaRefreshAttempts: [String: Double] = [:]
    static let mediaRefreshCooldown: TimeInterval = 60

    // Actor-local memo is never authoritative without a fresh open/stat/read.
    private struct MediaProbeMemo {
        let entry: AnyunCacheEntry
        let fingerprint: AnyunMediaFileValidation.Fingerprint
        let complete: Bool
    }
    static let mediaProbeMemoLimit = 4096
    private var mediaProbeMemos: [String: MediaProbeMemo] = [:]
    private var mediaProbeMemoOrder: [String] = []
    private var mediaProbeValidationCount = 0

    init(
        directoryName: String = AnyunCacheConstants.cacheDirectoryName,
        policyProvider: @escaping @Sendable () -> AnyunCachePolicy = { AnyunCachePolicyStore.shared.load() }
    ) {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let root = base.appendingPathComponent(directoryName, isDirectory: true)
        self.layout = AnyunCacheLayout(root: root)
        self.indexPath = root.appendingPathComponent(AnyunCacheConstants.indexFileName, isDirectory: false)
        self.policyProvider = policyProvider
        // No filesystem IO in actor init: shared may first be referenced on main.
    }

    // MARK: - 路径

    func fileURL(forKey key: String) -> URL {
        return layout.mediaFile(forKey: key)
    }

    /// scheme handler 需要把“是否命中”与“字节”分开问，这里提供入口。
    func exists(key: String) -> Bool {
        ensureIndexLoaded()
        return validatedEntry(key: key) != nil
    }

    // All lease IO is serialized with index mutation, clear and eviction.
    func acquirePlaybackLease(key: String) -> AnyunPlaybackLookup {
        ensureIndexLoaded()
        if !leasesSwept { releasePlaybackLeases(); leasesSwept = true }
        guard let entry = validatedEntry(key: key), entry.kind == .media,
              AnyunMediaFileValidation.isCompleteOpus(layout.mediaFile(forKey: key), bytes: entry.bytes) else {
            invalidate(key: key)
            return AnyunPlaybackLookup(url: nil, mediaEpoch: mediaEpoch)
        }
        guard let link = AnyunPlaybackCache.refreshLease(forKey: key, layout: layout) else {
            return AnyunPlaybackLookup(url: nil, mediaEpoch: mediaEpoch)
        }
        _ = lookup(key: key) // native hits participate in LRU too
        recentLeaseKeys = AnyunPlaybackCache.trimmedRecent(key, previous: recentLeaseKeys)
        prunePlaybackLeases()
        return AnyunPlaybackLookup(url: link, mediaEpoch: mediaEpoch)
    }

    /// Pure read, including cold start: no index repair/sweep, LRU, lease or network.
    /// Definite absence/invalid content is false; transient IO throws for bridge unknown.
    func mediaStatus(urls: [String]) throws -> [Bool] {
        guard urls.count <= 100, urls.allSatisfy(AnyunPlaybackCache.isStableMediaSource) else { throw AnyunCacheError.badURL }
        if urls.isEmpty { return [] }
        let snapshot = try mediaProbeEntries()
        return try urls.map { raw in
            let key = AnyunCacheKey.hash(raw)
            guard let entry = snapshot[key], entry.kind == .media, entry.bytes > 0 else { return false }
            let url = layout.mediaFile(forKey: key)
            guard let before = try AnyunMediaFileValidation.fingerprint(url) else { return false }
            guard before.isRegular, before.size == Int64(entry.bytes) else { return false }
            // Always open: file protection/ACL changes must not become stale cached=true.
            let handle: FileHandle
            do { handle = try FileHandle(forReadingFrom: url) }
            catch {
                if try AnyunMediaFileValidation.fingerprint(url) == nil { return false }
                throw error
            }
            defer { try? handle.close() }
            guard try AnyunMediaFileValidation.fingerprint(handle) == before else { throw AnyunDiskCacheFailure.ioFailure }
            let complete: Bool
            if let memo = mediaProbeMemos[key], memo.entry == entry, memo.fingerprint == before {
                // Tiny real read detects protection/read failure after successful open too.
                guard let byte = try handle.read(upToCount: 1), byte.count == 1 else { throw AnyunDiskCacheFailure.ioFailure }
                complete = memo.complete
            } else {
                mediaProbeValidationCount += 1
                complete = try AnyunMediaFileValidation.completeOpus(handle: handle, bytes: entry.bytes)
            }
            // Concurrent path/inode/content change must not publish a result for old bytes.
            guard try AnyunMediaFileValidation.fingerprint(handle) == before,
                  try AnyunMediaFileValidation.fingerprint(url) == before else { throw AnyunDiskCacheFailure.ioFailure }
            if mediaProbeMemos[key] == nil {
                if mediaProbeMemoOrder.count >= Self.mediaProbeMemoLimit {
                    mediaProbeMemos.removeValue(forKey: mediaProbeMemoOrder.removeFirst())
                }
                mediaProbeMemoOrder.append(key)
            }
            mediaProbeMemos[key] = MediaProbeMemo(entry: entry, fingerprint: before, complete: complete)
            return complete
        }
    }

    /// Do not call ensureIndexLoaded: its startup repair/eviction intentionally mutates disk.
    private func mediaProbeEntries() throws -> [String: AnyunCacheEntry] {
        if indexLoaded { return entries }
        let data: Data
        do { data = try Data(contentsOf: indexPath) }
        catch {
            if try AnyunMediaFileValidation.fingerprint(indexPath) == nil { return [:] }
            throw error
        }
        let decoded = try JSONDecoder().decode(AnyunCacheIndexFile.self, from: data)
        var snapshot: [String: AnyunCacheEntry] = [:]
        for entry in decoded.entries where AnyunCacheLayout.isValidKey(entry.key) { snapshot[entry.key] = entry }
        return snapshot
    }

    /// Read-only observability; no URLs or startup maintenance.
    func mediaProbeDiagnostics() -> (validations: Int, memoEntries: Int) {
        return (mediaProbeValidationCount, mediaProbeMemos.count)
    }

    func releasePlaybackLeases() {
        recentLeaseKeys = []
        prunePlaybackLeases()
    }

    private func prunePlaybackLeases() {
        let manager = FileManager.default
        guard let names = try? manager.contentsOfDirectory(atPath: layout.playbackDirectory.path) else { return }
        for name in names where name.hasPrefix(".lease-") || AnyunPlaybackCache.isDeletable(linkName: name, recent: recentLeaseKeys) {
            try? manager.removeItem(at: layout.playbackDirectory.appendingPathComponent(name))
        }
    }

    /// Only the failed local item is invalidated; active hard links remain readable.
    func invalidate(key: String) {
        guard AnyunCacheLayout.isValidKey(key) else { return }
        entries[key] = nil
        forgetMediaProbe(key)
        jsonRequests[key] = nil
        mediaRefreshOwners[key] = nil
        try? FileManager.default.removeItem(at: layout.mediaFile(forKey: key))
        persistIndex()
    }

    private func validatedEntry(key: String) -> AnyunCacheEntry? {
        guard AnyunCacheLayout.isValidKey(key), let entry = entries[key], entry.bytes > 0,
              let attrs = try? FileManager.default.attributesOfItem(atPath: layout.mediaFile(forKey: key).path),
              attrs[.type] as? FileAttributeType == .typeRegular,
              (attrs[.size] as? NSNumber)?.intValue == entry.bytes else {
            if entries[key] != nil { invalidate(key: key) }
            return nil
        }
        return entry
    }

    private func forgetMediaProbe(_ key: String) {
        mediaProbeMemos[key] = nil
        mediaProbeMemoOrder.removeAll { $0 == key }
    }

    private func rememberOversize(_ key: String) {
        if skippedKeys.count >= 128 { skippedKeys.removeAll(keepingCapacity: true) }
        skippedKeys.insert(key)
    }

    /// Native playback is a single prefetch lane; obsolete tracks stop consuming bandwidth.
    func cancelFileDownloads(except key: String? = nil) async {
        // Keep canceled slots until their network/file cleanup actually completes. Otherwise
        // rapid switching can accumulate detached downloads outside the apparent lane count.
        while let (oldKey, slot) = inFlightFiles.first(where: { $0.key != key || $0.value.epoch != mediaEpoch || $0.value.task.isCancelled }) {
            slot.task.cancel()
            _ = try? await slot.task.value
            if inFlightFiles[oldKey]?.id == slot.id { inFlightFiles[oldKey] = nil }
        }
    }

    // MARK: - 读

    /// 命中即 touch `lastAccess`（节流写盘），返回条目快照。
    func lookup(key: String) -> AnyunCacheEntry? {
        ensureIndexLoaded()
        guard var entry = validatedEntry(key: key) else { return nil }
        let now = Date().timeIntervalSince1970
        entry.lastAccess = now
        entries[key] = entry // touch memory on EVERY hit; only persistence is throttled
        if now - lastAccessPersistedAt >= AnyunCacheConstants.lastAccessPersistInterval {
            persistIndex()
        }
        return entry
    }

    /// 整段读取；条目不存在或文件丢失返回 nil（调用方自行回退网络）。
    func read(key: String) -> Data? {
        ensureIndexLoaded()
        guard validatedEntry(key: key) != nil else { return nil }
        return try? Data(contentsOf: fileURL(forKey: key), options: .mappedIfSafe)
    }

    /// 分段读取（`Range: bytes=start-end?`）。命中时 touch，返回切片与总长。
    func readRange(key: String, start: Int, end: Int?) -> AnyunRangeRead? {
        ensureIndexLoaded()
        guard var entry = validatedEntry(key: key) else { return nil }

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
        do { try handle.seek(toOffset: UInt64(safeStart)) } catch { return nil }
        guard let data = try? handle.read(upToCount: safeEnd - safeStart + 1),
              data.count == safeEnd - safeStart + 1 else { return nil }

        let now = Date().timeIntervalSince1970
        entry.lastAccess = now
        entries[key] = entry // touch memory on EVERY hit; only persistence is throttled
        if now - lastAccessPersistedAt >= AnyunCacheConstants.lastAccessPersistInterval {
            persistIndex()
        }
        return AnyunRangeRead(data: data, start: safeStart, endInclusive: safeEnd, totalBytes: total)
    }

    /// 预取字节预算：单次下载不得超过 maxBytes（超限既不落盘，也不该继续耗流量）。
    func downloadBudget() -> Int {
        ensureIndexLoaded()
        evict(protecting: nil)
        persistIndex()
        return policyProvider().maxBytes
    }

    /// 诊断/测试观测：当前是否有进行中的合并下载（两种形态合计）。不断言业务语义。
    func inFlightCount() -> Int {
        return inFlight.count + inFlightFiles.count
    }

    func isFileDownloadCancelled(key: String) -> Bool {
        return inFlightFiles[key]?.task.isCancelled ?? false
    }

    // MARK: - 写

    /// 写盘：文件原子写 + 更新索引 + LRU 淘汰 + 索引原子写。
    /// - Parameter requireExisting: 后台 revalidate 专用。条目已被 clear/淘汰时抛
    ///   `cancelled` 并拒绝写回 —— 清掉的缓存不许复活。
    @discardableResult
    func store(key: String, kind: AnyunCacheKind, payload: AnyunDownloadedPayload, requireExisting: Bool = false) throws -> AnyunCacheEntry {
        ensureIndexLoaded()
        guard AnyunCacheLayout.isValidKey(key) else { throw AnyunCacheError.badURL }
        if requireExisting && entries[key] == nil {
            throw AnyunCacheError.cancelled
        }
        let policy = policyProvider()
        guard !payload.data.isEmpty else {
            throw AnyunDiskCacheFailure.emptyPayload
        }
        guard payload.data.count <= policy.maxBytes else {
            rememberOversize(key)
            throw AnyunCacheOversizeError.oversize
        }
        return try storeUnlocked(key: key, kind: kind, payload: payload)
    }

    /// 真正写盘的内部实现（commit 路径已过全部校验，不再重复拦截）。
    private func storeUnlocked(key: String, kind: AnyunCacheKind, payload: AnyunDownloadedPayload) throws -> AnyunCacheEntry {
        ensureDirectory()

        let target = fileURL(forKey: key)
        do {
            try payload.data.write(to: target, options: .atomic)
        } catch {
            throw AnyunDiskCacheFailure.ioFailure
        }

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
        mediaRefreshOwners[key] = nil
        entries[key] = entry
        forgetMediaProbe(key)
        jsonRequests[key] = nil // any replacement invalidates outstanding JSON validators
        evict(protecting: key)
        persistIndex()
        return entry
    }

    /// Acquire before network/SWR scheduling, not when its delayed response arrives.
    /// Lookup and bytes are captured in one actor turn to avoid reading a replacement entry.
    func beginJSONRequest(key: String) throws -> AnyunJSONRequest {
        ensureIndexLoaded()
        guard AnyunCacheLayout.isValidKey(key) else { throw AnyunCacheError.badURL }
        let entry = lookup(key: key)
        let data = entry?.kind == .json ? read(key: key) : nil
        let id = UUID()
        jsonRequests[key] = id
        return AnyunJSONRequest(key: key, id: id, epoch: jsonEpoch,
                                entry: data == nil ? nil : entry, data: data)
    }

    func finishJSONRequest(_ request: AnyunJSONRequest) {
        if jsonRequests[request.key] == request.id { jsonRequests[request.key] = nil }
    }

    private func validateJSONRequest(_ request: AnyunJSONRequest) throws {
        guard request.epoch == jsonEpoch, jsonRequests[request.key] == request.id else {
            throw AnyunCacheError.cancelled
        }
    }

    /// Both ownership validation and store happen without an actor suspension. No unfenced overload.
    @discardableResult
    func storeJSON(request: AnyunJSONRequest, data: Data, etag: String?, lastModified: String?, contentType: String?) throws -> AnyunCacheEntry {
        try validateJSONRequest(request)
        let payload = AnyunDownloadedPayload(data: data, etag: etag, lastModified: lastModified, contentType: contentType)
        return try store(key: request.key, kind: .json, payload: payload)
    }

    /// A 304 only confirms the snapshot whose validators were sent. Replacements/evictions
    /// invalidate ownership even if their bytes/etag/timestamps happen to be identical (ABA).
    func revalidateJSON(request: AnyunJSONRequest) throws -> Data {
        try validateJSONRequest(request)
        guard request.entry != nil, let data = request.data,
              validatedEntry(key: request.key)?.kind == .json else { throw AnyunCacheError.cancelled }
        markRevalidated(key: request.key)
        return data
    }

    /// 304：只更新“内容确认时间”（age 归零），不动内容与 etag。条目已没了就什么都不做。
    func markRevalidated(key: String) {
        ensureIndexLoaded()
        guard var entry = entries[key] else { return }
        let now = Date().timeIntervalSince1970
        entry.createdAt = now
        entry.lastAccess = now
        entries[key] = entry
        jsonRequests[key] = nil
        mediaRefreshOwners[key] = nil
        persistIndex()
    }

    func revalidateMedia(key: String, original: AnyunCacheEntry, response: AnyunHTTPResponse) throws {
        ensureIndexLoaded()
        guard let current = entries[key], current.createdAt == original.createdAt,
              current.bytes == original.bytes, current.etag == original.etag else { throw AnyunCacheError.cancelled }
        if response.isNotModified { markRevalidated(key: key) }
        else if response.status == 200 {
            _ = try store(key: key, kind: .media, payload: AnyunDownloadedPayload(
                data: response.data, etag: response.etag, lastModified: response.lastModified,
                contentType: response.contentType), requireExisting: true)
        }
    }

    // MARK: - 并发合并下载

    /// 同 key 并发合并：第一个调用创建共享 worker，其余 await 同一个结果。
    /// `operation` 必须在 actor 之外完成网络 IO（不得回调本 actor，避免重入陷阱）。
    /// 语义修正：订阅者取消（含发起方被 WebKit stop）**不**杀 worker —— 取消只退订自己；
    /// worker 由自身的超时/资源上限约束，完成后照常写盘并服务其他订阅者。
    /// data worker 由 clear 取消；原生 file worker 另受当前曲单槽取消约束。
    func downloadOnce(
        key: String,
        kind: AnyunCacheKind,
        operation: @escaping @Sendable () async throws -> AnyunDownloadedPayload
    ) async throws -> AnyunDownloadOutcome {
        ensureIndexLoaded()
        try Task.checkCancellation()
        guard AnyunCacheLayout.isValidKey(key) else { throw AnyunCacheError.badURL }
        if let inflight = inFlight[key] {
            let result = try await inflight.task.value
            try Task.checkCancellation()
            return result
        }
        let slotID = UUID()
        let capturedEpoch = epoch
        let worker = Task.detached(priority: .utility) { () -> AnyunDownloadOutcome in
            do {
                let payload = try await operation()
                let outcome = try await self.commitData(
                    key: key, kind: kind, payload: payload, slotID: slotID, capturedEpoch: capturedEpoch
                )
                await self.releaseDataSlot(key: key, slotID: slotID)
                return outcome
            } catch {
                await self.releaseDataSlot(key: key, slotID: slotID)
                throw error
            }
        }
        inFlight[key] = InFlightData(id: slotID, epoch: capturedEpoch, kind: kind, task: worker)
        let result = try await worker.value
        try Task.checkCancellation()
        return result
    }

    /// worker 的提交点（actor 串行执行）：槽位身份 + epoch 双重校验，旧完成不许覆盖新任务；
    /// 超限单曲返回 transient（不落盘、标记 skip），其他调用方按需内存内服务。
    private func commitData(
        key: String,
        kind: AnyunCacheKind,
        payload: AnyunDownloadedPayload,
        slotID: UUID,
        capturedEpoch: Int
    ) throws -> AnyunDownloadOutcome {
        guard inFlight[key]?.id == slotID, inFlight[key]?.epoch == capturedEpoch else {
            throw AnyunCacheError.cancelled
        }
        guard !payload.data.isEmpty else {
            throw AnyunDiskCacheFailure.emptyPayload
        }
        let policy = policyProvider()
        if skippedKeys.contains(key) || payload.data.count > policy.maxBytes {
            if payload.data.count > policy.maxBytes { rememberOversize(key) }
            return .transient(payload)
        }
        let entry = try storeUnlocked(key: key, kind: kind, payload: payload)
        return .stored(entry)
    }

    /// 仅当槽位仍属于自己时释放（旧任务不得释放新槽）。
    private func releaseDataSlot(key: String, slotID: UUID) {
        if inFlight[key]?.id == slotID {
            inFlight[key] = nil
        }
    }

    /// AVPlayer 预取专用（文件形态，内存占用恒定）：
    /// - 已完整缓存 ⇒ 直接返回条目，零网络；
    /// - 已标记 skip ⇒ 抛 `oversize`，连下载都不发起（“单曲>容量不反复下载”）；
    /// - 其余走同 key 合并；提交 = 以**真实文件字节数**复核完整性后原子改名进最终路径。
    /// `operation` 失败时必须自行清理它的临时文件；成功返回后由 commit 接管。
    func downloadFileOnce(
        key: String,
        expectedMediaEpoch: Int? = nil,
        operation: @escaping @Sendable () async throws -> AnyunDownloadedFile
    ) async throws -> AnyunCacheEntry {
        ensureIndexLoaded()
        try Task.checkCancellation()
        guard AnyunCacheLayout.isValidKey(key) else { throw AnyunCacheError.badURL }
        if let expectedMediaEpoch, expectedMediaEpoch != mediaEpoch { throw AnyunCacheError.cancelled }
        await cancelFileDownloads(except: key)
        try Task.checkCancellation()
        if let expectedMediaEpoch, expectedMediaEpoch != mediaEpoch { throw AnyunCacheError.cancelled }
        if let entry = validatedEntry(key: key), entry.kind == .media,
           AnyunMediaFileValidation.isCompleteOpus(layout.mediaFile(forKey: key), bytes: entry.bytes) {
            return entry
        }
        if skippedKeys.contains(key) {
            throw AnyunCacheOversizeError.oversize
        }
        if let inflight = inFlightFiles[key] {
            let result = try await inflight.task.value
            try Task.checkCancellation()
            return result
        }
        let slotID = UUID()
        let capturedEpoch = mediaEpoch
        let worker = Task.detached(priority: .utility) { () -> AnyunCacheEntry in
            do {
                let file = try await operation()
                let entry = try await self.commitFile(
                    key: key, file: file, slotID: slotID, capturedEpoch: capturedEpoch
                )
                await self.releaseFileSlot(key: key, slotID: slotID)
                return entry
            } catch {
                if error is AnyunCacheOversizeError { await self.rememberFileOversize(key: key, slotID: slotID) }
                await self.releaseFileSlot(key: key, slotID: slotID)
                throw error
            }
        }
        inFlightFiles[key] = InFlightFile(id: slotID, epoch: capturedEpoch, task: worker)
        let result = try await worker.value
        try Task.checkCancellation()
        return result
    }

    /// Shares the prefetch lane; called only after returning/attaching a cached lease.
    func refreshMediaFileIfStale(
        key: String, expectedMediaEpoch: Int, now: Double = Date().timeIntervalSince1970,
        operation: @escaping @Sendable (AnyunCacheEntry, Int) async throws -> AnyunDownloadedFile
    ) async throws {
        ensureIndexLoaded()
        try Task.checkCancellation()
        guard expectedMediaEpoch == mediaEpoch else { throw AnyunCacheError.cancelled }
        guard let original = validatedEntry(key: key), original.kind == .media,
              now - original.createdAt > Double(policyProvider().mediaRevalidateSeconds),
              now - (mediaRefreshAttempts[key] ?? -Double.infinity) >= Self.mediaRefreshCooldown else { return }
        guard inFlightFiles[key] == nil, mediaRefreshOwners[key] == nil else { return }
        let slotID = UUID()
        mediaRefreshOwners[key] = slotID // ownership starts before any actor suspension
        defer { if mediaRefreshOwners[key] == slotID { mediaRefreshOwners[key] = nil } }
        await cancelFileDownloads(except: key)
        try Task.checkCancellation()
        // LRU touches during the cancellation await must not suppress a needed refresh.
        guard expectedMediaEpoch == mediaEpoch, mediaRefreshOwners[key] == slotID, let current = entries[key],
              current.createdAt == original.createdAt, current.bytes == original.bytes,
              current.etag == original.etag, current.lastModified == original.lastModified,
              inFlightFiles.isEmpty else { return }
        let capturedEpoch = mediaEpoch
        let budget = policyProvider().maxBytes
        if mediaRefreshAttempts.count >= 128 { mediaRefreshAttempts.removeAll(keepingCapacity: true) }
        mediaRefreshAttempts[key] = now
        let worker = Task.detached(priority: .utility) { () -> AnyunCacheEntry in
            do {
                let file = try await operation(original, budget)
                let entry = try await self.commitMediaRefresh(key: key, file: file, original: original, slotID: slotID, capturedEpoch: capturedEpoch)
                await self.releaseFileSlot(key: key, slotID: slotID)
                return entry
            } catch {
                await self.releaseFileSlot(key: key, slotID: slotID)
                throw error // validated cached bytes remain on network/validation failure
            }
        }
        inFlightFiles[key] = InFlightFile(id: slotID, epoch: capturedEpoch, task: worker)
        try await withTaskCancellationHandler {
            _ = try await worker.value
            try Task.checkCancellation()
        } onCancel: { worker.cancel() }
    }

    private func commitMediaRefresh(key: String, file: AnyunDownloadedFile, original: AnyunCacheEntry, slotID: UUID, capturedEpoch: Int) throws -> AnyunCacheEntry {
        guard inFlightFiles[key]?.id == slotID, inFlightFiles[key]?.task.isCancelled == false,
              mediaEpoch == capturedEpoch, mediaRefreshOwners[key] == slotID,
              validatedEntry(key: key)?.kind == .media else {
            try? FileManager.default.removeItem(at: file.fileURL)
            throw AnyunCacheError.cancelled
        }
        if file.notModified {
            guard original.etag != nil || original.lastModified != nil,
                  let existing = entries[key],
                  AnyunMediaFileValidation.isCompleteOpus(layout.mediaFile(forKey: key), bytes: existing.bytes) else {
                throw AnyunCacheError.cancelled
            }
            var entry = entries[key]!
            entry.createdAt = Date().timeIntervalSince1970 // only age; bytes/validators/LRU/lease unchanged
            entries[key] = entry
            mediaRefreshOwners[key] = nil
            persistIndex()
            return entry
        }
        return try commitFile(key: key, file: file, slotID: slotID, capturedEpoch: capturedEpoch)
    }

    private func commitFile(key: String, file: AnyunDownloadedFile, slotID: UUID, capturedEpoch: Int) throws -> AnyunCacheEntry {
        let manager = FileManager.default
        let discard = { try? manager.removeItem(at: file.fileURL) }
        guard inFlightFiles[key]?.id == slotID, mediaEpoch == capturedEpoch,
              inFlightFiles[key]?.task.isCancelled == false, !file.notModified else {
            discard()
            throw AnyunCacheError.cancelled
        }
        // 完整性以磁盘上的真实字节为准，不信下载器自报的数字；残片直接作废。
        guard let attributes = try? manager.attributesOfItem(atPath: file.fileURL.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let actual = (attributes[.size] as? NSNumber)?.intValue,
              actual > 0, actual == file.bytes else {
            discard()
            throw AnyunDiskCacheFailure.incompleteFile
        }
        let policy = policyProvider()
        guard actual <= policy.maxBytes, !skippedKeys.contains(key) else {
            rememberOversize(key)
            discard()
            throw AnyunCacheOversizeError.oversize
        }
        guard AnyunMediaFileValidation.isCompleteOpus(file.fileURL, bytes: actual) else {
            discard()
            throw AnyunDiskCacheFailure.incompleteFile
        }
        ensureDirectory()
        let target = layout.mediaFile(forKey: key)
        do {
            // Atomic replacement retains old bytes on IO failure; active lease keeps its inode.
            guard Darwin.rename(file.fileURL.path, target.path) == 0 else { throw AnyunDiskCacheFailure.ioFailure }
        } catch {
            discard()
            throw AnyunDiskCacheFailure.ioFailure
        }
        let now = Date().timeIntervalSince1970
        let previous = entries[key]
        let entry = AnyunCacheEntry(
            key: key,
            kind: .media,
            bytes: actual,
            createdAt: now,
            lastAccess: now,
            etag: file.etag, // a full 200 is a new representation; never retain old validators
            lastModified: file.lastModified,
            contentType: file.contentType ?? previous?.contentType
        )
        mediaRefreshOwners[key] = nil
        entries[key] = entry
        forgetMediaProbe(key)
        jsonRequests[key] = nil // any replacement invalidates outstanding JSON validators
        evict(protecting: key)
        persistIndex()
        return entry
    }

    private func rememberFileOversize(key: String, slotID: UUID) {
        if inFlightFiles[key]?.id == slotID, inFlightFiles[key]?.epoch == mediaEpoch { rememberOversize(key) }
    }

    private func releaseFileSlot(key: String, slotID: UUID) {
        if inFlightFiles[key]?.id == slotID {
            inFlightFiles[key] = nil
        }
        if mediaRefreshOwners[key] == slotID { mediaRefreshOwners[key] = nil }
    }

    // MARK: - 清理与统计

    func clear(scope: String) -> AnyunClearResult {
        ensureIndexLoaded()
        let normalized = scope.lowercased()
        let matchesAll = normalized.isEmpty || normalized == "all"
        let touchesMedia = matchesAll || normalized == "media"
        let touchesJson = matchesAll || normalized == "json"

        // 1) 先推进 epoch：在途 worker 的提交作废，用户清除的内容不允许复活。
        epoch += 1
        if touchesJson {
            jsonEpoch += 1
            jsonRequests.removeAll()
        }
        for (key, inflight) in inFlight {
            let selected = (inflight.kind == .media && touchesMedia) || (inflight.kind == .json && touchesJson)
            guard selected else { continue }
            inflight.task.cancel()
            if inFlight[key]?.id == inflight.id { inFlight[key] = nil }
        }
        if touchesMedia {
            mediaEpoch += 1
            mediaRefreshOwners.removeAll()
            mediaRefreshAttempts.removeAll()
            for inflight in inFlightFiles.values {
                inflight.task.cancel()
            }
            skippedKeys.removeAll()
            mediaProbeMemos.removeAll()
            mediaProbeMemoOrder.removeAll()
        }

        // 2) 删条目与文件。播放中的租约（playback/ 硬链接）不在这里动：字节由租约层
        //    负责释放，所以“清缓存”不会掐断正在播/拖动中的那首。
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
        evict(protecting: nil)
        persistIndex()
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
            cacheDir: layout.root.path
        )
    }

    // MARK: - 索引与淘汰

    private func ensureDirectory() {
        try? FileManager.default.createDirectory(at: layout.root, withIntermediateDirectories: true, attributes: nil)
        try? FileManager.default.createDirectory(at: layout.incomingDirectory, withIntermediateDirectories: true, attributes: nil)
    }

    private func ensureIndexLoaded() {
        guard !indexLoaded else { return }
        indexLoaded = true
        ensureDirectory()
        guard let data = try? Data(contentsOf: indexPath) else {
            entries = [:]
            sweepLeftovers()
            return
        }
        guard let decoded = try? JSONDecoder().decode(AnyunCacheIndexFile.self, from: data) else {
            entries = [:]
            sweepLeftovers()
            return
        }
        var table: [String: AnyunCacheEntry] = [:]
        for entry in decoded.entries {
            // 文件被系统清掉时索引会变脏：以文件存在为准。
            if AnyunCacheLayout.isValidKey(entry.key),
               entry.bytes > 0,
               let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL(forKey: entry.key).path),
               attrs[.type] as? FileAttributeType == .typeRegular,
               (attrs[.size] as? NSNumber)?.intValue == entry.bytes {
                table[entry.key] = entry
            }
        }
        entries = table
        sweepLeftovers()
        evict(protecting: nil)
        persistIndex()
    }

    /// 首次触达的一次性清扫：流式下载的临时残留（死进程留下的都不可信）与索引外的
    /// 孤儿 `.bin`。`playback/` 租约由 AnyunPlaybackCache 在冷启动时负责，这里不碰
    /// （AVPlayer 可能正在读）。
    private func sweepLeftovers() {
        let manager = FileManager.default
        if let names = try? manager.contentsOfDirectory(atPath: layout.incomingDirectory.path) {
            for name in names where !name.hasPrefix(".") {
                try? manager.removeItem(at: layout.incomingDirectory.appendingPathComponent(name, isDirectory: false))
            }
        }
        let suffix = ".\(AnyunCacheConstants.binaryExtension)"
        if let names = try? manager.contentsOfDirectory(atPath: layout.root.path) {
            for name in names where name.hasSuffix(suffix) {
                let key = String(name.dropLast(suffix.count))
                if AnyunCacheLayout.isValidKey(key), entries[key] == nil {
                    try? manager.removeItem(at: layout.mediaFile(forKey: key))
                }
            }
        }
    }

    /// Foundation 原子替换 index.json；不手工删正式索引，失败保留旧版本。
    private func persistIndex() {
        ensureDirectory()
        let payload = AnyunCacheIndexFile(version: 1, entries: entries.values.sorted { $0.key < $1.key })
        guard let data = try? JSONEncoder().encode(payload) else { return }

        do {
            try data.write(to: indexPath, options: .atomic)
            lastAccessPersistedAt = Date().timeIntervalSince1970
        } catch { /* Previous durable index remains; in-memory state stays authoritative. */ }
    }

    /// LRU：从最久未用开始删，只保护刚提交项；in-flight 不得让容量越界。
    private func evict(protecting protectedKey: String?) {
        let policy = policyProvider()
        var total = 0
        for entry in entries.values {
            total += entry.bytes
        }
        var count = entries.count
        guard total > policy.maxBytes || count > policy.maxEntries else { return }

        let candidates = entries.values
            .filter { $0.key != protectedKey }
            .sorted { $0.lastAccess < $1.lastAccess }

        for candidate in candidates {
            if total <= policy.maxBytes && count <= policy.maxEntries { break }
            try? FileManager.default.removeItem(at: fileURL(forKey: candidate.key))
            entries.removeValue(forKey: candidate.key)
            forgetMediaProbe(candidate.key)
            jsonRequests[candidate.key] = nil
            mediaRefreshOwners[candidate.key] = nil
            total -= candidate.bytes
            count -= 1
        }
    }
}

/// Bounded-memory Ogg framing + CRC check. This is not a decoder: AVPlayer failure still falls back.
enum AnyunMediaFileValidation {
    static func isCompleteOpus(_ url: URL, bytes: Int) -> Bool {
        guard bytes > 0, let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        return (try? completeOpus(handle: handle, bytes: bytes)) ?? false
    }

    /// False is definite framing/length/CRC/EOS failure; read errors propagate to probe.
    static func completeOpus(handle: FileHandle, bytes: Int) throws -> Bool {
        guard bytes > 0 else { return false }
        var consumed = 0
        var first = true
        var ended = false
        var serial: Data?
        var expectedSequence: UInt32 = 0
        while consumed < bytes {
            guard !ended, let headerData = try handle.read(upToCount: 27), headerData.count == 27 else { return false }
            var header = Array(headerData)
            guard Array(header[0..<4]) == Array("OggS".utf8), header[4] == 0 else { return false }
            let sequence = UInt32(header[18]) | UInt32(header[19]) << 8 | UInt32(header[20]) << 16 | UInt32(header[21]) << 24
            guard sequence == expectedSequence else { return false }
            expectedSequence &+= 1
            let pageSerial = Data(header[14..<18])
            if let serial { guard serial == pageSerial else { return false } } else { serial = pageSerial }
            let segmentCount = Int(header[26])
            let lacing: Data
            if segmentCount == 0 { lacing = Data() }
            else {
                guard let data = try handle.read(upToCount: segmentCount), data.count == segmentCount else { return false }
                lacing = data
            }
            let length = lacing.reduce(0) { $0 + Int($1) }
            let body: Data
            if length == 0 { body = Data() }
            else {
                guard let data = try handle.read(upToCount: length), data.count == length else { return false }
                body = data
            }
            if first {
                guard header[5] & 2 != 0, body.count >= 19, body.starts(with: Data("OpusHead".utf8)) else { return false }
                first = false
            }
            let storedCRC = UInt32(header[22]) | UInt32(header[23]) << 8 | UInt32(header[24]) << 16 | UInt32(header[25]) << 24
            header.replaceSubrange(22...25, with: [0, 0, 0, 0])
            var crc: UInt32 = 0
            for byte in Data(header) + lacing + body {
                crc = (crc << 8) ^ crcTable[Int((crc >> 24) ^ UInt32(byte))]
            }
            guard crc == storedCRC else { return false }
            consumed += 27 + segmentCount + length
            ended = header[5] & 4 != 0
        }
        return !first && ended && consumed == bytes
    }

    /// POSIX nanosecond identity/content/permission state, not rounded Foundation dates.
    struct Fingerprint: Equatable {
        let device: Int32
        let inode: UInt64
        let size: Int64
        let modifiedSeconds: Int
        let modifiedNanos: Int
        let changedSeconds: Int
        let changedNanos: Int
        let mode: UInt16
        let owner: UInt32
        let group: UInt32
        let flags: UInt32
        var isRegular: Bool { return mode & UInt16(S_IFMT) == UInt16(S_IFREG) }

        init(_ value: stat) {
            device = value.st_dev; inode = value.st_ino; size = value.st_size
            modifiedSeconds = value.st_mtimespec.tv_sec; modifiedNanos = value.st_mtimespec.tv_nsec
            changedSeconds = value.st_ctimespec.tv_sec; changedNanos = value.st_ctimespec.tv_nsec
            mode = value.st_mode; owner = value.st_uid; group = value.st_gid; flags = value.st_flags
        }
    }

    static func fingerprint(_ url: URL) throws -> Fingerprint? {
        var value = stat()
        guard Darwin.lstat(url.path, &value) == 0 else {
            let code = errno
            if code == ENOENT || code == ENOTDIR { return nil }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
        return Fingerprint(value)
    }

    static func fingerprint(_ handle: FileHandle) throws -> Fingerprint {
        var value = stat()
        guard Darwin.fstat(handle.fileDescriptor, &value) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return Fingerprint(value)
    }

    private static let crcTable: [UInt32] = (0..<256).map { value in
        var crc = UInt32(value) << 24
        for _ in 0..<8 { crc = (crc & 0x80000000 != 0) ? (crc << 1) ^ 0x04c11db7 : crc << 1 }
        return crc
    }
}
