//
//  test-native-cache.swift — 原生缓存层的行为测试（仅 macOS 可编译运行）。
//
//  本机（Linux 网关）没有 swiftc：以下命令在 mac 上执行，属于「Xcode/真机之前」的
//  本地闭环验证；它只依赖 Foundation/WebKit(Cocoa) 与仓库内 Swift 源文件，
//  全部走临时目录与注入的策略/operation，**不碰网络、不碰真实音频、不碰真实缓存目录**。
//
//      swiftc -swift-version 5 -strict-concurrency=minimal -parse-as-library \
//          ios/App/App/AnyunCacheConstants.swift \
//          ios/App/App/AnyunCacheNetwork.swift \
//          ios/App/App/AnyunDiskCache.swift \
//          ios/App/App/AnyunPlaybackCache.swift \
//          ios/App/App/AnyunCacheSchemeHandler.swift \
//          scripts/test-native-cache.swift \
//          -o /tmp/anyun-native-cache-test && /tmp/anyun-native-cache-test
//
//  覆盖：键/路径净化、Range 解析与 transient 切片、LRU 有界与保护项、超限单曲
//  （transient + skip 标记，不再反复下载）、downloadOnce 合并与「发起方取消不杀订阅」、
//  clear 的 epoch 作废（在途下载不复活）、JSON 请求 ownership/304 ABA、requireExisting 写回、downloadFileOnce
//  完整性校验（自报字节与真实字节不符 = 残片作废、临时文件清理）、冷启动清扫、
//  播放租约（硬链接、残链重建、bin 删除后租约仍可读）。
//

import Foundation

func check(_ condition: Bool, _ message: String) {
    if !condition {
        fputs("AnyunCache FAIL: \(message)\n", stderr)
        exit(1)
    }
}

func anyunKey(_ seed: String) -> String { AnyunCacheKey.hash(seed) }

actor Gate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var opened = false
    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
        opened = true
        let pending = waiters
        waiters = []
        for waiter in pending { waiter.resume() }
    }
}

actor Counter {
    private(set) var value = 0
    func bump() { value += 1 }
}

func waitUntil(_ condition: () async -> Bool) async {
    var spins = 0
    while !(await condition()) {
        spins += 1
        if spins > 2000 { return } // 防呆：测试环境自行超时，靠后续断言兜底
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
}

func makePolicy(maxBytes: Int, maxEntries: Int = 4000) -> AnyunCachePolicy {
    return AnyunCachePolicy(maxBytes: maxBytes, maxEntries: maxEntries, mediaRevalidateSeconds: 604800, jsonStaleSeconds: 60)
}

func payloadOf(_ bytes: Int) -> AnyunDownloadedPayload {
    AnyunDownloadedPayload(data: Data(repeating: 0x5a, count: bytes), etag: "\"e\(bytes)\"", lastModified: nil, contentType: "audio/ogg")
}

func writeTempDownload(_ data: Data, to url: URL) throws -> AnyunDownloadedFile {
    try data.write(to: url)
    return AnyunDownloadedFile(fileURL: url, bytes: data.count, etag: nil, lastModified: nil, contentType: "audio/ogg")
}

// Synthetic Ogg/Opus framing, no song data and intentionally not an AVPlayer decoder test.
func opusFixture(bytes: Int) -> Data {
    var lacing: [UInt8] = []
    for count in 1...255 {
        let bodyBytes = bytes - 27 - count
        if bodyBytes >= 19 && bodyBytes >= 255 * (count - 1) && bodyBytes < 255 * count {
            lacing = Array(repeating: 255, count: count - 1) + [UInt8(bodyBytes - 255 * (count - 1))]
            break
        }
    }
    precondition(!lacing.isEmpty)
    var header = Array(repeating: UInt8(0), count: 27)
    header.replaceSubrange(0..<4, with: Array("OggS".utf8))
    header[5] = 6 // BOS + EOS for a single framing-test page
    header[26] = UInt8(lacing.count)
    var body = Array(repeating: UInt8(0), count: bytes - 27 - lacing.count)
    body.replaceSubrange(0..<8, with: Array("OpusHead".utf8))
    var page = header + lacing + body
    var crc: UInt32 = 0
    for byte in page {
        crc ^= UInt32(byte) << 24
        for _ in 0..<8 { crc = crc & 0x80000000 != 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1 }
    }
    for i in 0..<4 { page[22 + i] = UInt8(truncatingIfNeeded: crc >> (i * 8)) }
    return Data(page)
}

@main
struct AnyunCacheTests {
    static func main() async {
        await testPureLogic()
        await testLease()
        await testActorBasics()
        await testOversizeBounded()
        await testDownloadOnceCoalesceAndCancel()
        await testClearEpochAndRequireExisting()
        await testDownloadFileOnceIntegrity()
        await testColdStartSweep()
        await testPlaybackLeaseSerializationAndCorruption()
        await testFileClearAndLaneCancellation()
        await testScopedClearAndRevalidateABA()
        await testJSONRequestOwnership()
        print("AnyunCache: layout/lease/LRU/oversize/coalesce/cancel/epoch/JSON-ownership-ABA/integrity/sweep passed (macOS, no network)")
    }

    // MARK: - 纯逻辑

    static func testPureLogic() async {
        let key = anyunKey("https://example.invalid/api/audio/" + String(repeating: "a", count: 64) + ".opus")
        check(key.count == 64 && key.allSatisfy({ "0123456789abcdef".contains($0) }), "hash shape")
        check(key == anyunKey("https://example.invalid/api/audio/" + String(repeating: "a", count: 64) + ".opus"), "hash deterministic")

        check(AnyunCacheLayout.isValidKey(key), "64-hex key valid")
        check(!AnyunCacheLayout.isValidKey("../../etc/passwd"), "traversal key rejected")
        check(!AnyunCacheLayout.isValidKey(String(repeating: "A", count: 64)), "uppercase rejected")

        let layout = AnyunCacheLayout(root: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true))
        check(layout.playbackLink(forKey: "../../x") == nil, "illegal key has no link path")
        check(layout.incomingFile(named: "a/b/part").lastPathComponent == "a_b_part", "incoming name sanitized")

        let policy = makePolicy(maxBytes: 1).clamped()
        check(policy.maxBytes == AnyunCachePolicy.maxBytesRange.lowerBound, "clamp lower")
        check(AnyunCachePolicy(maxBytes: Int.max, maxEntries: 1, mediaRevalidateSeconds: 0, jsonStaleSeconds: 0).clamped().maxBytes
              == AnyunCachePolicy.maxBytesRange.upperBound, "clamp upper")

        // Range 解析
        check(AnyunCacheSchemeHandler.parseRangeHeader("bytes=100-200")?.start == 100, "range start")
        check(AnyunCacheSchemeHandler.parseRangeHeader("bytes=100-200")?.end == 200, "range end")
        let openEnded = AnyunCacheSchemeHandler.parseRangeHeader("bytes=100-")
        check(openEnded != nil && openEnded?.start == 100 && openEnded?.end == nil, "open range")
        check(AnyunCacheSchemeHandler.parseRangeHeader("bytes=-500") == nil, "suffix range falls back to full")
        check(AnyunCacheSchemeHandler.parseRangeHeader("bits=1") == nil, "junk header")

        // transient 切片与 readRange 同一套边界规则
        let data = Data(repeating: 7, count: 10)
        if case let read? = AnyunCacheSchemeHandler.slice(data, start: 0, end: nil) {
            check(read.data.count == 10 && !read.isPartial, "transient full slice")
        } else { check(false, "slice nil full") }
        if case let read? = AnyunCacheSchemeHandler.slice(data, start: 4, end: 999) {
            check(read.data.count == 6 && read.isPartial && read.endInclusive == 9, "transient clamps past EOF")
        } else { check(false, "slice nil partial") }
        check(AnyunCacheSchemeHandler.slice(Data(), start: 0, end: nil) == nil, "empty transient yields no read")

        // remoteURL 权限面：只接受 anyun-cache://media?u=<https>
        let okURL = URL(string: "anyun-cache://media?u=https%3A%2F%2Fexample.invalid%2Fa.opus")!
        check(AnyunCacheSchemeHandler.remoteURL(from: okURL)?.absoluteString == "https://example.invalid/a.opus", "scheme unwraps https")
        let fileURL = URL(string: "anyun-cache://media?u=file%3A%2F%2F%2Fetc%2Fpasswd")!
        check(AnyunCacheSchemeHandler.remoteURL(from: fileURL) == nil, "file target rejected — 桥权限不对任意 fileURL 开放")
        let plainFile = URL(string: "file:///etc/passwd")!
        check(AnyunCacheSchemeHandler.remoteURL(from: plainFile) == nil, "bare fileURL rejected")
    }

    // MARK: - 播放租约（硬链接）

    static func testLease() async {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("anyun-lease-\(UUID().uuidString)", isDirectory: true)
        let layout = AnyunCacheLayout(root: dir)
        let fm = FileManager.default
        defer { try? fm.removeItem(at: dir) }
        try? fm.createDirectory(at: layout.root, withIntermediateDirectories: true)

        let key = anyunKey("lease-track")
        check(AnyunPlaybackCache.refreshLease(forKey: key, layout: layout) == nil, "no bin → no lease")

        let bin = layout.mediaFile(forKey: key)
        try! Data("first".utf8).write(to: bin)
        guard let link = AnyunPlaybackCache.refreshLease(forKey: key, layout: layout) else {
            check(false, "bin → lease link created"); return
        }
        check(link.pathExtension == AnyunCacheLayout.playbackExtension, "lease carries .ogg extension")
        check(link.lastPathComponent == "\(key).ogg", "lease name")
        check(String(data: try! Data(contentsOf: link), encoding: .utf8) == "first", "lease reads same bytes")

        // 同 key 覆盖写（inode 变了）：残链必须重建为新内容，绝不把旧内容当命中。
        try! fm.createDirectory(at: layout.incomingDirectory, withIntermediateDirectories: true)
        let staged = layout.incomingFile(named: "rewrite")
        try! Data("second".utf8).write(to: staged)
        try! fm.removeItem(at: bin)
        try! fm.moveItem(at: staged, to: bin)
        guard let refreshed = AnyunPlaybackCache.refreshLease(forKey: key, layout: layout) else {
            check(false, "lease refreshed after overwrite"); return
        }
        check(String(data: try! Data(contentsOf: refreshed), encoding: .utf8) == "second", "stale link rebuilt")

        // bin 被 LRU/clear 删除后：租约链接仍可读；下一次 miss 也不能破坏当前 reader。
        try! fm.removeItem(at: bin)
        check(String(data: try! Data(contentsOf: link), encoding: .utf8) == "second", "lease survives bin removal — 播放不断流")
        check(AnyunPlaybackCache.refreshLease(forKey: key, layout: layout) == nil, "bin gone → future hit rejected")

        // 租约数量有界 + 外来文件不误删
        check(AnyunPlaybackCache.trimmedRecent("c", previous: ["a", "b"]) == ["c", "a"], "recent keeps 2, newest first")
        check(AnyunPlaybackCache.isDeletable(linkName: "\(key).ogg", recent: [key]) == false, "current kept")
        check(AnyunPlaybackCache.isDeletable(linkName: "\(anyunKey("old")).ogg", recent: [key]), "old lease deletable")
        check(AnyunPlaybackCache.isDeletable(linkName: "notes.txt", recent: []) == false, "foreign file untouched")
    }

    // MARK: - actor 基础 + LRU 有界

    static func testActorBasics() async {
        let dirName = "anyun-cache-test-\(UUID().uuidString)"
        let cache = AnyunDiskCache(directoryName: dirName, policyProvider: { makePolicy(maxBytes: 250) })
        let root = cache.layout.root
        defer { try? FileManager.default.removeItem(at: root) }

        let a = anyunKey("a"), b = anyunKey("b"), c = anyunKey("c")
        _ = try! await cache.store(key: a, kind: .media, payload: payloadOf(100))
        try? await Task.sleep(nanoseconds: 2_000_000)
        _ = try! await cache.store(key: b, kind: .media, payload: payloadOf(100))
        try? await Task.sleep(nanoseconds: 2_000_000)
        _ = try! await cache.store(key: c, kind: .media, payload: payloadOf(100))

        let stats = await cache.stats()
        check(stats.bytes <= 250, "LRU keeps total bounded (got \(stats.bytes))")
        check(await cache.lookup(key: a) == nil, "oldest evicted")
        check(await cache.lookup(key: c) != nil, "newest survives")
        check(!FileManager.default.fileExists(atPath: cache.layout.mediaFile(forKey: a).path), "evicted bytes gone")

        if case let read? = await cache.readRange(key: c, start: 50, end: nil) {
            check(read.data.count == 50 && read.isPartial && read.totalBytes == 100, "readRange open-ended")
        } else { check(false, "readRange returned nil") }

        // 索引持久化：新实例从 index.json 恢复条目
        let reopen = AnyunDiskCache(directoryName: dirName, policyProvider: { makePolicy(maxBytes: 250) })
        check(await reopen.lookup(key: c) != nil, "index survives instance restart")

        // markRevalidated 不复活已消失条目
        await reopen.markRevalidated(key: a)
        check(await reopen.lookup(key: a) == nil, "304 refresh never resurrects")

        let limited = AnyunDiskCache(directoryName: "anyun-count-test-\(UUID().uuidString)", policyProvider: { makePolicy(maxBytes: 1000, maxEntries: 2) })
        defer { try? FileManager.default.removeItem(at: limited.layout.root) }
        _ = try! await limited.store(key: a, kind: .json, payload: payloadOf(50))
        try? await Task.sleep(nanoseconds: 2_000_000)
        _ = try! await limited.store(key: b, kind: .json, payload: payloadOf(50))
        try? await Task.sleep(nanoseconds: 2_000_000)
        _ = await limited.lookup(key: a) // hit within the persist window still touches memory
        _ = try! await limited.store(key: c, kind: .json, payload: payloadOf(50))
        check(await limited.stats().entries == 2, "maxEntries enforced independently of bytes")
        check(await limited.lookup(key: b) == nil, "recently read a beats untouched b in LRU")
    }

    // MARK: - 超限单曲：有界且不反复下载

    static func testOversizeBounded() async {
        let dirName = "anyun-cache-test-\(UUID().uuidString)"
        let cache = AnyunDiskCache(directoryName: dirName, policyProvider: { makePolicy(maxBytes: 150) })
        let root = cache.layout.root
        defer { try? FileManager.default.removeItem(at: root) }
        let key = anyunKey("fat-track")

        let counter = Counter()
        let outcome = try! await cache.downloadOnce(key: key, kind: .media) {
            await counter.bump()
            return payloadOf(200) // > maxBytes
        }
        switch outcome {
        case .stored: check(false, "oversize must not be stored")
        case .transient(let payload): check(payload.data.count == 200, "oversize served transient")
        }
        check(await cache.lookup(key: key) == nil, "oversize never indexed")
        check(!FileManager.default.fileExists(atPath: cache.layout.mediaFile(forKey: key).path), "oversize never on disk")

        // 播放预取路径：已标记 skip → 连下载都不发起（不反复下载）
        let prefetchRuns = Counter()
        do {
            _ = try await cache.downloadFileOnce(key: key) {
                await prefetchRuns.bump()
                return try writeTempDownload(Data(repeating: 1, count: 200), to: cache.layout.incomingFile(named: "x1.part"))
            }
            check(false, "skipped key must throw oversize without download")
        } catch AnyunCacheOversizeError.oversize {
            // expected
        } catch { check(false, "wrong error for skipped key: \(error)") }
        check(await prefetchRuns.value == 0, "no download attempted for skipped key")

        // store() 直接拒收超限并打 skip
        do {
            _ = try await cache.store(key: anyunKey("another-fat"), kind: .media, payload: payloadOf(200))
            check(false, "store must reject oversize")
        } catch AnyunCacheOversizeError.oversize {
            // expected
        } catch { check(false, "store oversize wrong error: \(error)") }
    }

    // MARK: - downloadOnce：合并 + 发起方取消不误杀

    static func testDownloadOnceCoalesceAndCancel() async {
        let dirName = "anyun-cache-test-\(UUID().uuidString)"
        let cache = AnyunDiskCache(directoryName: dirName, policyProvider: { makePolicy(maxBytes: 4096) })
        let root = cache.layout.root
        defer { try? FileManager.default.removeItem(at: root) }
        let key = anyunKey("merged")

        let gate = Gate()
        let runs = Counter()
        let op: @Sendable () async throws -> AnyunDownloadedPayload = {
            await runs.bump()
            await gate.wait()
            return payloadOf(16)
        }
        let first = Task { try await cache.downloadOnce(key: key, kind: .media, operation: op) }
        await waitUntil { await cache.inFlightCount() > 0 }
        first.cancel() // 发起方取消（WebKit stop 的常态）
        let second = Task { try await cache.downloadOnce(key: key, kind: .media, operation: op) }
        try? await Task.sleep(nanoseconds: 20_000_000)
        await gate.open()

        let outcome = try! await second.value
        switch outcome {
        case .stored: break
        case .transient: check(false, "subscriber lost the stored result after initiator cancel")
        }
        check(await runs.value == 1, "same-key downloads merge into one worker (got \(await runs.value))")
        do {
            _ = try await first.value
            check(false, "cancelled initiator must surface cancellation")
        } catch is CancellationError {
            // expected
        } catch {
            // actor 侧把订阅者取消包成 AnyunCacheError.cancelled 也算通过
            let code = (error as NSError).code
            check(code == NSURLErrorCancelled || error is AnyunCacheError, "cancelled initiator error: \(error)")
        }
        check(await cache.lookup(key: key) != nil, "worker finished despite initiator cancel")
    }

    // MARK: - clear 的 epoch：在途下载不得复活

    static func testClearEpochAndRequireExisting() async {
        let dirName = "anyun-cache-test-\(UUID().uuidString)"
        let cache = AnyunDiskCache(directoryName: dirName, policyProvider: { makePolicy(maxBytes: 4096) })
        let root = cache.layout.root
        defer { try? FileManager.default.removeItem(at: root) }
        let key = anyunKey("racing-clear")

        let gate = Gate()
        let op: @Sendable () async throws -> AnyunDownloadedPayload = {
            await gate.wait()
            return payloadOf(24)
        }
        let task = Task { try await cache.downloadOnce(key: key, kind: .media, operation: op) }
        await waitUntil { await cache.inFlightCount() > 0 }
        _ = await cache.clear(scope: "all") // 用户清除：epoch 前进 + 取消 worker
        await gate.open()                   // operation 不听取消（模拟慢 IO），返回后必须被 epoch 作废
        do {
            _ = try await task.value
            check(false, "in-flight download must not commit after clear")
        } catch {
            // expected: cancelled
        }
        check(await cache.lookup(key: key) == nil, "cleared entry never resurrects from in-flight commit")
        check(!FileManager.default.fileExists(atPath: cache.layout.mediaFile(forKey: key).path), "no bytes left after clear race")

        // clear 之后重新下载同一 key 正常入库（skip/槽位没有卡死）
        let entry = try! await cache.downloadOnce(key: key, kind: .media, operation: { payloadOf(24) })
        if case .stored = entry { } else { check(false, "re-download after clear should store") }

        // requireExisting：条目已没 → 写回作废（后台 revalidate 不复活）
        _ = await cache.clear(scope: "media")
        do {
            _ = try await cache.store(key: key, kind: .media, payload: payloadOf(24), requireExisting: true)
            check(false, "requireExisting store must reject missing entry")
        } catch let error as AnyunCacheError {
            check(error.code == "CANCELLED", "requireExisting rejects with cancelled")
        } catch { check(false, "requireExisting wrong error: \(error)") }
    }

    // MARK: - downloadFileOnce：完整性与替换

    static func testDownloadFileOnceIntegrity() async {
        let dirName = "anyun-cache-test-\(UUID().uuidString)"
        let cache = AnyunDiskCache(directoryName: dirName, policyProvider: { makePolicy(maxBytes: 1000) })
        let root = cache.layout.root
        defer { try? FileManager.default.removeItem(at: root) }
        let key = anyunKey("file-prefetch")

        let runs = Counter()
        let entry = try! await cache.downloadFileOnce(key: key) {
            await runs.bump()
            return try writeTempDownload(opusFixture(bytes: 120), to: cache.layout.incomingFile(named: "\(key)-one.part"))
        }
        check(entry.bytes == 120 && entry.kind == .media, "file commit stores entry bytes")
        check(FileManager.default.fileExists(atPath: cache.layout.mediaFile(forKey: key).path), "final file in place")

        // 已缓存 → 直接返回，零下载；同 key 合并去重
        let cached = try! await cache.downloadFileOnce(key: key) {
            await runs.bump()
            return try writeTempDownload(opusFixture(bytes: 120), to: cache.layout.incomingFile(named: "never.part"))
        }
        check(cached.bytes == 120, "cached fast path skips network")
        check(await runs.value == 1, "cached key must not re-download")

        // 残片：自报字节数与真实字节不符 → 作废，不进索引、不留临时文件
        let badKey = anyunKey("liar")
        do {
            _ = try await cache.downloadFileOnce(key: badKey) {
                let temp = cache.layout.incomingFile(named: "liar.part")
                try Data(repeating: 9, count: 10).write(to: temp)
                return AnyunDownloadedFile(fileURL: temp, bytes: 999, etag: nil, lastModified: nil, contentType: nil)
            }
            check(false, "liar payload must be rejected")
        } catch AnyunDiskCacheFailure.incompleteFile {
            // expected
        } catch { check(false, "incomplete file wrong error: \(error)") }
        check(await cache.lookup(key: badKey) == nil, "fragment never indexed")
        check(!FileManager.default.fileExists(atPath: cache.layout.incomingFile(named: "liar.part").path), "fragment temp cleaned")

        // 超限文件：不入库 + 打 skip（下一次连下载都不发起）
        let fatKey = anyunKey("fat-file")
        let fatRuns = Counter()
        do {
            _ = try await cache.downloadFileOnce(key: fatKey) {
                await fatRuns.bump()
                return try writeTempDownload(Data(repeating: 1, count: 1001), to: cache.layout.incomingFile(named: "fat.part"))
            }
            check(false, "oversize file must throw")
        } catch AnyunCacheOversizeError.oversize { } catch { check(false, "oversize wrong error: \(error)") }
        do {
            _ = try await cache.downloadFileOnce(key: fatKey) {
                await fatRuns.bump()
                return try writeTempDownload(Data(repeating: 1, count: 1001), to: cache.layout.incomingFile(named: "fat2.part"))
            }
            check(false, "skipped oversize must throw before download")
        } catch AnyunCacheOversizeError.oversize { } catch { check(false, "second oversize wrong error: \(error)") }
        check(await fatRuns.value == 1, "oversize never downloads twice")
        check(!FileManager.default.fileExists(atPath: cache.layout.mediaFile(forKey: fatKey).path), "oversize never reaches final path")
    }

    // MARK: - 冷启动清扫

    static func testColdStartSweep() async {
        let dirName = "anyun-cache-test-\(UUID().uuidString)"
        let cache = AnyunDiskCache(directoryName: dirName, policyProvider: { makePolicy(maxBytes: 4096) })
        let root = cache.layout.root
        defer { try? FileManager.default.removeItem(at: root) }
        // 实例创建 ≠ 索引加载：先往目录里塞脏数据，再触发首次访问。
        let fm = FileManager.default
        let layout = cache.layout
        try! fm.createDirectory(at: layout.incomingDirectory, withIntermediateDirectories: true)
        try! Data("stale".utf8).write(to: layout.incomingFile(named: "orphan.part"))
        let orphanKey = anyunKey("orphan")
        try! Data("orphan bytes".utf8).write(to: layout.mediaFile(forKey: orphanKey))
        let ghostKey = anyunKey("ghost")
        let index = AnyunCacheIndexFile(version: 1, entries: [
            AnyunCacheEntry(key: ghostKey, kind: .media, bytes: 5, createdAt: 1, lastAccess: 1, etag: nil, lastModified: nil, contentType: nil),
        ])
        try! JSONEncoder().encode(index).write(to: layout.indexFile)

        let stats = await cache.stats() // 触发 ensureIndexLoaded + sweep
        check(stats.entries == 0, "ghost index entry (file gone) dropped, got \(stats.entries)")
        check(!fm.fileExists(atPath: layout.incomingFile(named: "orphan.part").path), "incoming leftovers swept")
        check(!fm.fileExists(atPath: layout.mediaFile(forKey: orphanKey).path), "orphan .bin swept")
    }
    static func testPlaybackLeaseSerializationAndCorruption() async {
        let cache = AnyunDiskCache(directoryName: "anyun-cache-test-\(UUID().uuidString)", policyProvider: { makePolicy(maxBytes: 250) })
        defer { try? FileManager.default.removeItem(at: cache.layout.root) }
        let key = anyunKey("valid-local")
        let valid = opusFixture(bytes: 120)
        _ = try! await cache.store(key: key, kind: .media, payload: AnyunDownloadedPayload(data: valid, etag: nil, lastModified: nil, contentType: "audio/ogg"))
        let lookup = await cache.acquirePlaybackLease(key: key)
        guard let lease = lookup.url else { check(false, "validated local cache yields lease"); return }
        let binAttrs = try! FileManager.default.attributesOfItem(atPath: cache.layout.mediaFile(forKey: key).path)
        let leaseAttrs = try! FileManager.default.attributesOfItem(atPath: lease.path)
        check((binAttrs[.systemFileNumber] as? NSNumber) == (leaseAttrs[.systemFileNumber] as? NSNumber), "lease must share inode, not symlink/copy")
        _ = await cache.clear(scope: "media")
        check((try! Data(contentsOf: lease)) == valid, "active lease survives clear and seek-sized reads")
        check(await cache.acquirePlaybackLease(key: key).url == nil, "clear removes future cache hits")
        check((try! Data(contentsOf: lease)) == valid, "future miss must not remove current lease")
        // A stale lookup token cannot start a download after the user cleared media.
        let runs = Counter()
        do {
            _ = try await cache.downloadFileOnce(key: key, expectedMediaEpoch: lookup.mediaEpoch) {
                await runs.bump()
                return try writeTempDownload(valid, to: cache.layout.incomingFile(named: "stale.part"))
            }
            check(false, "stale prefetch token rejected")
        } catch { }
        check(await runs.value == 0, "clear does not resurrect through delayed prefetch scheduling")
        // Truncation and same-length body corruption both reject a future native hit.
        for corrupt in [Data(valid.dropLast()), Data(valid.dropLast()) + Data([1])] {
            _ = try! await cache.store(key: key, kind: .media, payload: AnyunDownloadedPayload(data: valid, etag: nil, lastModified: nil, contentType: nil))
            try! corrupt.write(to: cache.layout.mediaFile(forKey: key), options: .atomic)
            check(await cache.acquirePlaybackLease(key: key).url == nil, "truncated/CRC-corrupt cache is not a hit")
        }
        // Leases remain physically bounded after many selections and evictions.
        for i in 0..<8 {
            let k = anyunKey("lease-\(i)")
            _ = try! await cache.store(key: k, kind: .media, payload: AnyunDownloadedPayload(data: valid, etag: nil, lastModified: nil, contentType: nil))
            check(await cache.acquirePlaybackLease(key: k).url != nil, "new lease acquired")
        }
        let names = try! FileManager.default.contentsOfDirectory(atPath: cache.layout.playbackDirectory.path)
        check(names.count <= 2, "at most two hard-link leases remain")
        await cache.releasePlaybackLeases()
        check((try! FileManager.default.contentsOfDirectory(atPath: cache.layout.playbackDirectory.path)).isEmpty, "release removes all managed leases")
    }

    static func testFileClearAndLaneCancellation() async {
        let cache = AnyunDiskCache(directoryName: "anyun-cache-test-\(UUID().uuidString)", policyProvider: { makePolicy(maxBytes: 4096) })
        defer { try? FileManager.default.removeItem(at: cache.layout.root) }
        let a = anyunKey("old-file"), b = anyunKey("new-file")
        let gate = Gate()
        let oldTemp = cache.layout.incomingFile(named: "old.part")
        let old = Task {
            try await cache.downloadFileOnce(key: a) {
                await gate.wait() // deliberately ignores cancellation, simulating a late callback
                return try writeTempDownload(opusFixture(bytes: 120), to: oldTemp)
            }
        }
        await waitUntil { await cache.inFlightCount() > 0 }
        let next = Task {
            try await cache.downloadFileOnce(key: b) {
                return try writeTempDownload(opusFixture(bytes: 120), to: cache.layout.incomingFile(named: "new.part"))
            }
        }
        await waitUntil { await cache.isFileDownloadCancelled(key: a) }
        check(await cache.inFlightCount() == 1, "next track waits for canceled file cleanup, never concurrent full downloads")
        await gate.open()
        _ = try! await next.value
        do { _ = try await old.value; check(false, "obsolete lane must not commit") } catch { }
        check(await cache.lookup(key: a) == nil, "old track not cached after switching lane")
        check(!FileManager.default.fileExists(atPath: oldTemp.path), "late old file cleaned")
        let gate2 = Gate()
        let temp2 = cache.layout.incomingFile(named: "clear.part")
        let pending = Task {
            try await cache.downloadFileOnce(key: a) {
                await gate2.wait()
                return try writeTempDownload(opusFixture(bytes: 120), to: temp2)
            }
        }
        await waitUntil { await cache.inFlightCount() > 0 }
        _ = await cache.clear(scope: "media")
        await gate2.open()
        do { _ = try await pending.value; check(false, "clear rejects old file commit") } catch { }
        check(await cache.lookup(key: a) == nil && !FileManager.default.fileExists(atPath: temp2.path), "clear cleans late file without resurrection")
        // HTTP-style success with HTML/truncated Ogg must not become a complete file.
        do {
            _ = try await cache.downloadFileOnce(key: a) {
                try writeTempDownload(Data("<html>not audio</html>".utf8), to: cache.layout.incomingFile(named: "html.part"))
            }
            check(false, "non-Opus file rejected")
        } catch AnyunDiskCacheFailure.incompleteFile { } catch { check(false, "unexpected format failure") }
        let retried = try! await cache.downloadFileOnce(key: a) {
            try writeTempDownload(opusFixture(bytes: 120), to: cache.layout.incomingFile(named: "retry.part"))
        }
        check(retried.bytes == 120, "transient/format failure is retryable, not permanently blacklisted")
    }

    static func storeJSON(_ cache: AnyunDiskCache, _ request: AnyunJSONRequest, _ data: Data) async throws -> AnyunCacheEntry {
        try await cache.storeJSON(request: request, data: data, etag: "same-validator", lastModified: nil, contentType: "application/json")
    }

    static func expectJSONCancelled(_ message: String, _ operation: () async throws -> Void) async {
        do { try await operation(); check(false, message) }
        catch AnyunCacheError.cancelled { }
        catch { check(false, "Unexpected JSON error: \(error) — \(message)") }
    }

    // Real actor + filesystem tests. Gates model responses that ignore cancellation; no network.
    static func testJSONRequestOwnership() async {
        let cache = AnyunDiskCache(directoryName: "anyun-cache-test-\(UUID().uuidString)", policyProvider: { makePolicy(maxBytes: 4096, maxEntries: 2) })
        defer { try? FileManager.default.removeItem(at: cache.layout.root) }
        let key = anyunKey("json-ownership")
        let oldData = Data("{\"version\":1}".utf8)
        let newData = Data("{\"version\":2}".utf8) // same byte length, same validator

        // Cold fetch and warm SWR 200 must not resurrect entries after either JSON clear scope.
        for scope in ["json", "all"] {
            for warm in [false, true] {
                _ = await cache.clear(scope: "all")
                if warm {
                    let seed = try! await cache.beginJSONRequest(key: key)
                    _ = try! await storeJSON(cache, seed, oldData)
                }
                let old = try! await cache.beginJSONRequest(key: key)
                let gate = Gate()
                let late = Task { () async throws -> AnyunCacheEntry in
                    await gate.wait()
                    return try await storeJSON(cache, old, oldData)
                }
                _ = await cache.clear(scope: scope)
                await gate.open()
                await expectJSONCancelled("late JSON 200 cannot resurrect after \(scope), warm=\(warm)") { _ = try await late.value }
                check(await cache.lookup(key: key) == nil, "cleared JSON remains absent")
                check(!FileManager.default.fileExists(atPath: cache.layout.mediaFile(forKey: key).path), "late JSON leaves no bin")
                if warm {
                    await expectJSONCancelled("late JSON 304 cannot revive an absent entry") { _ = try await cache.revalidateJSON(request: old) }
                }
                let replacement = try! await cache.beginJSONRequest(key: key)
                let stored = try! await storeJSON(cache, replacement, newData)
                await expectJSONCancelled("old 200 cannot overwrite post-clear replacement") { _ = try await storeJSON(cache, old, oldData) }
                await expectJSONCancelled("old 304 cannot reset replacement age") { _ = try await cache.revalidateJSON(request: old) }
                check(await cache.lookup(key: key)?.createdAt == stored.createdAt, "replacement confirmation time unchanged")
                check(await cache.read(key: key) == newData, "replacement bytes unchanged")
            }
        }

        // Latest BEGUN request wins, not latest response. Old cleanup cannot release new ownership.
        let first = try! await cache.beginJSONRequest(key: key)
        let latest = try! await cache.beginJSONRequest(key: key)
        await cache.finishJSONRequest(first)
        await expectJSONCancelled("older request loses before latest commits") { _ = try await storeJSON(cache, first, oldData) }
        await expectJSONCancelled("older validator loses before latest commits") { _ = try await cache.revalidateJSON(request: first) }
        let newest = try! await storeJSON(cache, latest, newData)
        await expectJSONCancelled("older response loses after latest commits") { _ = try await storeJSON(cache, first, oldData) }
        await expectJSONCancelled("older 304 loses after latest commits") { _ = try await cache.revalidateJSON(request: first) }
        check(await cache.lookup(key: key)?.createdAt == newest.createdAt, "old 304 did not age newest")
        // A newer failed request does not give the old request ownership back.
        let loser = try! await cache.beginJSONRequest(key: key)
        let failed = try! await cache.beginJSONRequest(key: key)
        await cache.finishJSONRequest(failed)
        await expectJSONCancelled("failed newest request never re-enables old writer") { _ = try await storeJSON(cache, loser, oldData) }

        // Media clear (and unknown scopes) do not invalidate JSON, including 304.
        let mediaSafe = try! await cache.beginJSONRequest(key: key)
        _ = await cache.clear(scope: "media")
        _ = await cache.clear(scope: "unknown")
        _ = try! await storeJSON(cache, mediaSafe, oldData)
        let validator = try! await cache.beginJSONRequest(key: key)
        _ = await cache.clear(scope: "media")
        try? await Task.sleep(nanoseconds: 2_000_000)
        let confirmed = try! await cache.revalidateJSON(request: validator)
        check(confirmed == oldData, "valid 304 returns its own atomic snapshot")
        check(await cache.lookup(key: key)!.createdAt >= validator.entry!.createdAt, "valid 304 confirms age")
        await expectJSONCancelled("consumed request cannot commit again") { _ = try await storeJSON(cache, validator, newData) }

        // Direct replacement/invalidation/eviction also fence outstanding validators (no clear needed).
        let replaced = try! await cache.beginJSONRequest(key: key)
        _ = try! await cache.store(key: key, kind: .json, payload: AnyunDownloadedPayload(data: oldData, etag: "same-validator", lastModified: nil, contentType: "application/json"))
        await expectJSONCancelled("identical replacement invalidates old 304 ownership") { _ = try await cache.revalidateJSON(request: replaced) }
        let invalidated = try! await cache.beginJSONRequest(key: key)
        await cache.invalidate(key: key)
        await expectJSONCancelled("invalidated entry cannot be recreated by SWR") { _ = try await storeJSON(cache, invalidated, oldData) }
        let seed = try! await cache.beginJSONRequest(key: key)
        _ = try! await storeJSON(cache, seed, oldData)
        let evicted = try! await cache.beginJSONRequest(key: key)
        for name in ["json-other-a", "json-other-b"] {
            try? await Task.sleep(nanoseconds: 2_000_000)
            let other = try! await cache.beginJSONRequest(key: anyunKey(name))
            _ = try! await storeJSON(cache, other, newData)
        }
        check(await cache.lookup(key: key) == nil, "test actually evicts JSON snapshot")
        await expectJSONCancelled("eviction cannot be undone by late SWR 200") { _ = try await storeJSON(cache, evicted, oldData) }
        await expectJSONCancelled("evicted snapshot cannot be confirmed by 304") { _ = try await cache.revalidateJSON(request: evicted) }

        // Separate keys retain separate ownership, and a cold request cannot confirm a 304.
        let a = try! await cache.beginJSONRequest(key: anyunKey("json-independent-a"))
        let b = try! await cache.beginJSONRequest(key: anyunKey("json-independent-b"))
        await expectJSONCancelled("304 without cached validators is rejected") { _ = try await cache.revalidateJSON(request: a) }
        _ = try! await storeJSON(cache, a, oldData)
        _ = try! await storeJSON(cache, b, newData)
        await cache.finishJSONRequest(a)
        await cache.finishJSONRequest(b)
    }

    static func testScopedClearAndRevalidateABA() async {
        let cache = AnyunDiskCache(directoryName: "anyun-cache-test-\(UUID().uuidString)", policyProvider: { makePolicy(maxBytes: 4096) })
        defer { try? FileManager.default.removeItem(at: cache.layout.root) }
        let key = anyunKey("scoped")
        let gate = Gate()
        let worker = Task { try await cache.downloadOnce(key: key, kind: .json) { await gate.wait(); return payloadOf(20) } }
        await waitUntil { await cache.inFlightCount() > 0 }
        _ = await cache.clear(scope: "media")
        await gate.open()
        do { _ = try await worker.value } catch { check(false, "media-only clear must not cancel JSON worker") }
        _ = await cache.clear(scope: "all")
        let old = try! await cache.store(key: key, kind: .media, payload: payloadOf(100))
        _ = await cache.clear(scope: "media")
        try? await Task.sleep(nanoseconds: 2_000_000)
        _ = try! await cache.store(key: key, kind: .media, payload: payloadOf(120))
        let response = AnyunHTTPResponse(status: 200, data: Data(repeating: 1, count: 80), etag: nil, lastModified: nil, contentType: nil)
        do { try await cache.revalidateMedia(key: key, original: old, response: response); check(false, "old refresh cannot overwrite replacement after clear") } catch { }
        check(await cache.lookup(key: key)?.bytes == 120, "new entry survives old revalidation")
    }

}
