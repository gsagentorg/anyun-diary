import UIKit
import AVFoundation
import MediaPlayer
import Capacitor
import OSLog

/// The plugin owns playback, independently of the web view and its lifecycle.
@objc(NativePlaybackPlugin)
public class NativePlaybackPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePlaybackPlugin"
    public let jsName = "NativePlayback"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "command", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise)
    ]
    private let audio = AVPlayer()
    /// 切曲代数：所有异步结果（预取完成/失败）都要核对它，过期即丢，旧结果不改状态。
    private var loadGeneration = 0
    /// 当前曲完整下载订阅；切曲退订并取消旧文件 worker，文件清理完成后才启动下一槽。
    private var prefetchTask: Task<Void, Never>?
    private var mediaRefreshTask: Task<Void, Never>?
    /// 当前 item 的音源：streaming = 稳定 https（307 自动跟随到签名目标，目标只存在于单次传输），
    /// cached = 磁盘完整文件的播放租约（硬链接，淘汰/清除不断流）。
    private enum PlaybackSource {
        case none
        case streaming(key: String, url: URL)
        case cached(key: String)
    }
    private var playbackSource: PlaybackSource = .none
    // One attempt per explicit selection, not an unbounded/permanent failure-key set.
    private var prefetchAttempted = false
    private var prefetchEpoch = 0
    private var loadTask: Task<Void, Never>?
    private var resolvingCache = false
    private var skipLocalForCurrentTrack = false
    private var queue: [[String: Any]] = []
    private var pos = -1
    private var history: [Int] = []
    private var redo: [Int] = []
    private var played: [String] = []
    private var shuffle = false
    /// 单曲循环：自然播完时从头重播（手动上/下一首仍按队列走）。
    private var repeatOne = false
    private var skipSame = true
    private var rate: Float = 1
    private var revision = ""
    private var sequence = 0
    private var errorMessage = ""
    private var sleepState = NativeSleep()
    private var timer: Timer?
    private var timeObserver: Any?
    private var itemObserver: NSKeyValueObservation?
    private var controlObserver: NSKeyValueObservation?
    private var notifications: [NSObjectProtocol] = []
    private var targets: [(MPRemoteCommand, Any)] = []
    private var sessionStorage: AnyObject?
    private var infoCenter = MPNowPlayingInfoCenter.default()
    private var activationPending = false
    private var resumeAfterInterruption = false
    private var wantsPlayback = false
    private var lastSave = Date.distantPast
    private var lastProgressSent = Date.distantPast
    private var catalogDirty = true
    private let audioSessionQueue = DispatchQueue(label: "anyun.audio-session")
    private var audioActivationToken = UUID()
    private var audioActivationPending = false
    private var recoveringPlayback = false
    private var lastKnownDuration: Double = 0
    private var recoveryAttempts = 0
    private var lastProgressAt = Date()
    private var failureDetectedAt: Date?
    private var retryAt: Date?
    private var lastPosition: Double = 0
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "anyun", category: "Playback")
    private let logQueue = DispatchQueue(label: "anyun.playback.log")
    private let verboseDiagnostics = ProcessInfo.processInfo.environment["ANYUN_VERBOSE_LOGS"] == "1"
    private let savedKey = "anyun-native-playback-v1"

    public override func load() {
        DispatchQueue.main.async { self.setup() }
    }
    private func setup() {
        diagnostic("setup")
        // 冷启动先清掉上次进程（含崩溃）残留的播放租约，磁盘不无限增长。
        // Disk actor purges stale leases once, before its first acquirePlaybackLease.
        audio.audiovisualBackgroundPlaybackPolicy = .continuesIfPossible
        var remote = MPRemoteCommandCenter.shared()
        if #available(iOS 16.0, *) {
            let session = MPNowPlayingSession(players: [audio])
            session.delegate = self
            session.automaticallyPublishesNowPlayingInfo = false
            sessionStorage = session
            infoCenter = session.nowPlayingInfoCenter
            remote = session.remoteCommandCenter
        }
        bind(remote.playCommand) { self.start() }
        bind(remote.pauseCommand) { self.pause(); return true }
        bind(remote.togglePlayPauseCommand) { if self.wantsPlayback { self.pause(); return true }; return self.start() }
        bind(remote.nextTrackCommand) { self.step(1); return true }
        bind(remote.previousTrackCommand) { self.step(-1); return true }
        remote.changePlaybackPositionCommand.isEnabled = true
        targets.append((remote.changePlaybackPositionCommand, remote.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self, let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            return self.onMain { self.seek(event.positionTime); return true }
        }))
        controlObserver = audio.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.activateSession(); self.publish()
            }
        }
        timeObserver = audio.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] _ in
            self?.tick(); self?.publish(progressOnly: true)
        }
        let sleepTimer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(sleepTimer, forMode: .common)
        timer = sleepTimer
        let center = NotificationCenter.default
        notifications.append(center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            guard let self, let item = note.object as? AVPlayerItem, item === self.audio.currentItem else { return }
            if self.sleepState.stopAtTrackEnd(at: Date().timeIntervalSince1970 * 1000) { self.finishSleep() }
            // Repeat-one keeps the current item; start() rewinds a finished item and resumes.
            else if self.repeatOne { _ = self.start() }
            else { self.step(1, ended: true) }
        })
        notifications.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt else { return }
            if type == AVAudioSession.InterruptionType.began.rawValue {
                self.resumeAfterInterruption = self.wantsPlayback
                self.pause()
            } else {
                let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                if self.resumeAfterInterruption && AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume) { _ = self.start() }
                self.resumeAfterInterruption = false
            }
        })
        notifications.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            if (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.pause() }
        })
        for name in [AVPlayerItem.playbackStalledNotification, AVPlayerItem.failedToPlayToEndTimeNotification, AVPlayerItem.newErrorLogEntryNotification] {
            notifications.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let self, let item = note.object as? AVPlayerItem, item === self.audio.currentItem else { return }
                let event = item.errorLog()?.events.last
                self.diagnostic(name.rawValue, detail: "domain=\(event?.errorDomain ?? "") code=\(event?.errorStatusCode ?? 0)")
                if name == AVPlayerItem.failedToPlayToEndTimeNotification {
                    self.failureDetectedAt = Date(); self.retryAt = nil
                }
            })
        }
        notifications.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.catalogDirty = true
            self.diagnostic("foreground")
            self.tick(); self.publish()
        })
        notifications.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.diagnostic("background"); self?.persist(); self?.publish() })
        if let saved = UserDefaults.standard.dictionary(forKey: savedKey), let items = restoredQueue(saved) {
            queue = NativeLyrics.hydrate(items); pos = saved["pos"] as? Int ?? -1
            rate = (saved["rate"] as? NSNumber)?.floatValue ?? 1
            shuffle = saved["shuffle"] as? Bool ?? false
            repeatOne = saved["repeatOne"] as? Bool ?? false
            skipSame = saved["skipSame"] as? Bool ?? true
            history = saved["history"] as? [Int] ?? []; redo = saved["redo"] as? [Int] ?? []
            played = saved["played"] as? [String] ?? []
            // Restore paused without discarding a valid wall-clock sleep countdown.
            sleepState.configure(revision: saved["sleepRevision"] as? String ?? "restored",
                until: saved["sleepUntil"] as? Double, started: saved["sleepStarted"] as? Double,
                mode: saved["sleepMode"] as? String ?? "off", afterTrack: saved["afterTrack"] as? Bool ?? false,
                custom: NativeSleepCustom.decode(saved["sleepCustom"] as? [String: Any], version: saved["sleepCustomVersion"] as? Int))
            loadCurrent(autoplay: false, at: saved["position"] as? Double ?? 0)
        }
    }
    private func restoredQueue(_ saved: [String: Any]) -> [[String: Any]]? {
        if let data = saved["queueJSON"] as? Data,
           let items = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]], valid(items) {
            return items
        }
        // v1 stored clip.file as id and the resolved HTTPS URL verbatim. Keep
        // those identities, order and optional metadata (including absent audio/
        // monthId); neither dates nor a replacement JS queue can be inferred.
        if let items = saved["queue"] as? [[String: Any]], valid(items) { return items }
        return nil
    }
    private func valid(_ items: [[String: Any]]) -> Bool {
        items.allSatisfy { item in
            guard item["id"] is String, item["key"] is String, item["title"] is String,
                  let raw = item["url"] as? String, let url = URL(string: raw) else { return false }
            return url.scheme == "https" && url.host != nil
        }
    }
    @objc func configure(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let items = call.getArray("queue") as? [[String: Any]], self.valid(items) else {
                call.reject("原生播放需要有效的 HTTPS 音频地址"); return
            }
            let previous = self.currentID
            let previousRate = self.rate
            self.catalogDirty = true
            self.queue = NativeLyrics.hydrate(items)
            self.pos = call.getInt("pos") ?? -1
            self.history = call.getArray("history", Int.self) ?? []
            self.redo = call.getArray("redo", Int.self) ?? []
            self.played = call.getArray("played", String.self) ?? []
            self.shuffle = call.getBool("shuffle") ?? false
            self.repeatOne = call.getBool("repeatOne") ?? false
            self.skipSame = call.getBool("skipSame") ?? true
            self.rate = Float(call.getDouble("rate") ?? 1)
            self.revision = call.getString("revision") ?? ""
            self.sleepState.configure(revision: call.getString("sleepRevision") ?? "",
                until: call.getDouble("sleepUntil"), started: call.getDouble("sleepStarted"),
                mode: call.getString("sleepMode") ?? "off", afterTrack: call.getBool("afterTrack") ?? false,
                custom: NativeSleepCustom.decode(call.getObject("sleepCustom")?.mapValues { $0 as Any }, version: call.getInt("sleepCustomVersion")))
            // Expiry and gain must be applied before a rate update can resume audio.
            self.tick()
            if call.getBool("replace") == true || previous != self.currentID {
                self.loadCurrent(autoplay: false)
            } else if self.rate != previousRate && self.wantsPlayback && !self.audioActivationPending { self.audio.rate = self.rate }
            self.tick(); self.persist(); self.publish()
            call.resolve(self.snapshot())
        }
    }
    @objc func command(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            switch call.getString("action") {
            case "play": if !self.start() { call.reject(self.errorMessage); return }
            case "pause": self.pause()
            case "seek": self.seek(call.getDouble("value") ?? 0)
            case "rate":
                self.tick()
                self.rate = Float(min(8, max(0.01, call.getDouble("value") ?? 1)))
                if self.wantsPlayback && !self.audioActivationPending { self.audio.rate = self.rate }
            case "next": self.step(1)
            case "previous": self.step(-1)
            case "random": self.random()
            default: call.reject("未知播放命令"); return
            }
            self.persist(); self.publish(); call.resolve(self.snapshot())
        }
    }
    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.tick(); call.resolve(self.snapshot()) }
    }
    private var currentID: String { queue.indices.contains(pos) ? queue[pos]["id"] as? String ?? "" : "" }
    private var expired: Bool { sleepState.until.map { Date().timeIntervalSince1970 * 1000 >= $0 } ?? false }
    private func loadCurrent(autoplay: Bool, at: Double = 0, recovering: Bool = false) {
        if !recovering {
            recoveryAttempts = 0; lastKnownDuration = 0
            prefetchAttempted = false; skipLocalForCurrentTrack = false
        }
        if recovering, let duration = audio.currentItem?.duration.seconds, duration.isFinite, duration > 0 { lastKnownDuration = duration }
        recoveringPlayback = recovering
        lastPosition = at; lastProgressAt = Date(); failureDetectedAt = nil; retryAt = nil
        diagnostic(recovering ? "reload" : "load")
        if !recovering && queue.indices.contains(pos) {
            let count = (queue[pos]["lyrics"] as? [[String: Any]])?.count ?? 0
            diagnostic("lyrics-ready", detail: "lines=\(count)")
        }
        audioActivationToken = UUID(); audioActivationPending = false
        if !recovering { errorMessage = "" }
        wantsPlayback = false; audio.pause(); itemObserver = nil
        loadGeneration += 1
        let generation = loadGeneration
        loadTask?.cancel(); loadTask = nil
        resolvingCache = false
        prefetchTask?.cancel(); prefetchTask = nil
        mediaRefreshTask?.cancel(); mediaRefreshTask = nil
        guard queue.indices.contains(pos), let raw = queue[pos]["url"] as? String,
              let url = URL(string: raw), url.scheme == "https" else {
            playbackSource = .none
            audio.replaceCurrentItem(with: nil)
            loadTask = Task { @MainActor in
                guard !Task.isCancelled else { return }
                await AnyunDiskCache.shared.cancelFileDownloads()
                guard !Task.isCancelled else { return }
                await AnyunPlaybackCache.shared.releaseAllLeases()
            }
            publish(); return
        }
        // 缓存键永远是稳定源 URL（队列里的 https）；签名目标不作为键、不落盘、不进日志。
        let key = AnyunCacheKey.hash(url.absoluteString)
        // Disk lookup/validation/linking runs on the actor, never synchronously on main.
        // Keep user intent while awaiting it; late completion must not undo pause/sleep/seek.
        resolvingCache = true
        wantsPlayback = autoplay
        audio.replaceCurrentItem(with: nil)
        let skipLocal = skipLocalForCurrentTrack
        loadTask = Task { @MainActor [weak self] in
            guard !Task.isCancelled else { return }
            let disk = AnyunDiskCache.shared
            await disk.cancelFileDownloads(except: key)
            guard !Task.isCancelled else { return }
            if skipLocal { await disk.invalidate(key: key) }
            guard !Task.isCancelled else { return }
            let lookup = await AnyunPlaybackCache.shared.localPlaybackURL(forKey: key)
            guard let self, !Task.isCancelled, self.loadGeneration == generation else { return }
            self.prefetchEpoch = lookup.mediaEpoch
            self.resolvingCache = false
            self.loadTask = nil
            let shouldPlay = self.wantsPlayback && !self.expired && !self.sleepState.fired
            if let local = lookup.url, !skipLocal {
                self.playbackSource = .cached(key: key)
                self.diagnostic("cache-hit", detail: "key=\(Self.keyPrefix(key))")
                self.attach(AVPlayerItem(url: local), at: self.lastPosition, autoplay: shouldPlay, recovering: recovering)
                self.startMediaRefresh(key: key, url: url, expectedEpoch: lookup.mediaEpoch)
            } else {
                self.playbackSource = .streaming(key: key, url: url)
                self.attach(AVPlayerItem(url: url), at: self.lastPosition, autoplay: shouldPlay, recovering: recovering)
            }
        }
        publish()
    }

    /// 统一的商品安装点：观察者→替换→定位→自动播放→广播。缓存/流式两条路径共用，行为一致。
    private func attach(_ item: AVPlayerItem, at: Double, autoplay: Bool, recovering: Bool) {
        itemObserver = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self, item === self.audio.currentItem else { return }
                if item.status == .failed {
                    self.failureDetectedAt = Date(); self.retryAt = nil
                    if case .cached = self.playbackSource { self.skipLocalForCurrentTrack = true }
                    if self.wantsPlayback { self.recoveringPlayback = true }
                    if self.errorMessage.isEmpty {
                        if case .streaming = self.playbackSource {
                            self.errorMessage = "本曲未缓存，离线时无法播放；正在尝试恢复连接"
                        } else { self.errorMessage = "本地音频无法播放，正在尝试联网恢复" }
                    }
                    let error = item.error as NSError?
                    self.diagnostic("item-failed", detail: "domain=\(error?.domain ?? "") code=\(error?.code ?? 0)")
                }
                self.publish()
            }
        }
        audio.replaceCurrentItem(with: item)
        if at > 0 { seek(at) }
        if autoplay { _ = start(recovering: recovering) }
        publish()
    }

    /// 未缓存时：流式播放稳定地址 + 并行完整下载到 AnyunDiskCache。
    /// 下载只针对当前曲；同 key 由 actor 去重合并；完成/失败永不替换当前 item（不把
    /// 后来曲盖回），下次 load/恢复自然命中磁盘。每次明确选曲最多预取一次，重选可重试。
    private func startPrefetch(key: String, url: URL) {
        let generation = loadGeneration
        let expectedEpoch = prefetchEpoch
        prefetchAttempted = true
        let disk = AnyunDiskCache.shared
        let network = AnyunCacheNetwork.shared
        // 每次订阅的临时路径唯一（带 UUID）：被 clear 取消的旧 worker 可能还在收尾，
        // 不许与新 worker 写同一个文件；commit 按 operation 回报的真实路径接管。
        let destination = AnyunCacheLayout.standard.incomingFile(named: "\(key)-\(UUID().uuidString).part")
        prefetchTask = Task.detached(priority: .utility) { [weak self] in
            do {
                let budget = await disk.downloadBudget()
                try Task.checkCancellation()
                _ = try await disk.downloadFileOnce(key: key, expectedMediaEpoch: expectedEpoch) {
                    try await network.downloadFile(url, to: destination, maxBytes: budget)
                }
                await MainActor.run {
                    guard let self, self.loadGeneration == generation else { return }
                    self.prefetchTask = nil
                    self.diagnostic("prefetch-done", detail: "key=\(Self.keyPrefix(key))")
                }
            } catch AnyunCacheOversizeError.oversize {
                await MainActor.run {
                    guard let self, self.loadGeneration == generation else { return }
                    self.prefetchTask = nil
                    if self.loadGeneration == generation {
                        self.diagnostic("prefetch-skip", detail: "oversize key=\(Self.keyPrefix(key))")
                    }
                }
            } catch is CancellationError {
                // Selection cancellation does not mutate a later generation.
            } catch let error as AnyunCacheError where error.code == "CANCELLED" {
                // 切曲退订 / 用户 clear 后的作废：静默退场，不进失败名单。
            } catch {
                let ns = error as NSError
                await MainActor.run {
                    guard let self, self.loadGeneration == generation else { return }
                    self.prefetchTask = nil
                    if self.loadGeneration == generation {
                        self.diagnostic("prefetch-failed", detail: "domain=\(ns.domain) code=\(ns.code)")
                        if self.errorMessage.isEmpty,
                           case .streaming(let currentKey, _) = self.playbackSource, currentKey == key,
                           self.audio.currentItem?.status == .failed {
                            // 离线且未缓存：中文直说，不假装还在加载；恢复循环保有界重试。
                            self.errorMessage = "本曲未能下载：离线且未缓存，无法播放"
                            self.publish()
                        }
                    }
                }
            }
        }
    }

    /// Return/attach the local hit FIRST. Refresh completion never touches item, seek or intent.
    private func startMediaRefresh(key: String, url: URL, expectedEpoch: Int) {
        let disk = AnyunDiskCache.shared
        let network = AnyunCacheNetwork.shared
        let destination = disk.layout.incomingFile(named: "\(key)-\(UUID().uuidString).part")
        mediaRefreshTask = Task.detached(priority: .utility) {
            do {
                try Task.checkCancellation()
                try await disk.refreshMediaFileIfStale(key: key, expectedMediaEpoch: expectedEpoch) { entry, budget in
                    try await network.downloadFile(url, to: destination, maxBytes: budget, etag: entry.etag, lastModified: entry.lastModified)
                }
            } catch { /* SWR is best-effort; cache and current AVPlayerItem remain untouched. */ }
        }
    }

    private static func keyPrefix(_ key: String) -> String {
        return String(key.prefix(8))
    }
    private func start(recovering: Bool = false) -> Bool {
        if !recovering { recoveryAttempts = 0 }
        if resolvingCache {
            if expired { finishSleep(); return true }
            sleepState.fired = false
            wantsPlayback = true
            publish(); return true
        }
        lastProgressAt = Date()
        if expired { finishSleep(); return true }
        sleepState.fired = false
        guard audio.currentItem != nil else { errorMessage = "没有可播放的曲目"; return false }
        if audio.currentItem?.status == .failed {
            if case .cached = playbackSource { skipLocalForCurrentTrack = true }
            if recovering {
                wantsPlayback = true; recoveringPlayback = true
                failureDetectedAt = Date(); retryAt = nil
                publish(); return true // watchdog owns bounded retries; no recursive attach loop
            }
            loadCurrent(autoplay: true, at: lastPosition, recovering: true)
            return true
        }
        // 流式播放真正被请求时才并行发起当前曲的完整下载（同 key 在 actor 内合并；
        // 每次明确选曲最多一次，恢复/长暂停不会形成下载风暴；重选后允许瞬时网络错误重试）。
        if case .streaming(let key, let url) = playbackSource, prefetchTask == nil, !prefetchAttempted, !skipLocalForCurrentTrack {
            startPrefetch(key: key, url: url)
        }
        let duration = audio.currentItem?.duration.seconds ?? 0
        if duration.isFinite && duration > 0 && audio.currentTime().seconds >= duration { seek(0) }
        tick()
        if sleepState.fired { return true }
        if !recovering { errorMessage = "" }
        wantsPlayback = true
        audioActivationPending = true
        let token = UUID()
        audioActivationToken = token
        // Category changes and legacy activation can block; keep both off the UI thread.
        audioSessionQueue.async {
            let session = AVAudioSession.sharedInstance()
            let complete: (Bool, Error?) -> Void = { activated, error in
                DispatchQueue.main.async {
                    guard self.audioActivationToken == token, self.wantsPlayback else { return }
                    self.audioActivationPending = false
                    guard activated else {
                        self.wantsPlayback = false
                        self.errorMessage = error?.localizedDescription ?? "音频会话激活失败"
                        let failure = error as NSError?
                        self.diagnostic("activation-failed", detail: "domain=\(failure?.domain ?? "") code=\(failure?.code ?? 0)")
                        self.publish(); return
                    }
                    self.tick()
                    guard self.audioActivationToken == token, self.wantsPlayback, !self.resolvingCache, !self.sleepState.fired else { return }
                    self.lastProgressAt = Date()
                    self.audio.playImmediately(atRate: self.rate)
                    self.activateSession(); self.publish()
                }
            }
            do {
                try session.setCategory(.playback, mode: .default)
                if #available(iOS 27.0, *) {
                    session.activate(options: [], completionHandler: complete)
                } else {
                    try session.setActive(true)
                    complete(true, nil)
                }
            } catch { complete(false, error) }
        }
        publish()
        return true
    }
    private func pause() {
        diagnostic("pause")
        audioActivationToken = UUID(); audioActivationPending = false
        recoveringPlayback = false
        wantsPlayback = false; audio.pause(); publish()
    }
    private func seek(_ seconds: Double) {
        guard seconds.isFinite else { return }
        lastPosition = max(0, seconds); lastProgressAt = Date()
        if resolvingCache { persist(); publish(); return }
        let generation = loadGeneration
        audio.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 600)) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.loadGeneration == generation else { return }
                self.persist(); self.publish()
            }
        }
    }
    private func visit() {
        guard queue.indices.contains(pos) else { return }
        history.append(pos)
        let key = queue[pos]["key"] as? String ?? ""
        if !played.contains(key) { played.append(key) }
    }
    private func random() {
        let titles = Set(queue.filter { played.contains($0["key"] as? String ?? "") }.compactMap { $0["title"] as? String })
        var candidates = queue.indices.filter { $0 != pos && !played.contains(queue[$0]["key"] as? String ?? "") && (!skipSame || !titles.contains(queue[$0]["title"] as? String ?? "")) }
        if candidates.isEmpty { played = []; candidates = queue.indices.filter { $0 != pos } }
        guard let next = candidates.randomElement() else { return }
        visit(); redo = []; pos = next; loadCurrent(autoplay: true)
    }
    private func step(_ delta: Int, ended: Bool = false) {
        if shuffle {
            if delta > 0 {
                if let next = redo.popLast(), queue.indices.contains(next) { visit(); pos = next; loadCurrent(autoplay: true) }
                else { random(); if ended && queue.count <= 1 { pause() } }
            } else if let previous = history.popLast(), queue.indices.contains(previous) {
                redo.append(pos); pos = previous; loadCurrent(autoplay: true)
            }
        } else if queue.indices.contains(pos + delta) {
            visit(); pos += delta; loadCurrent(autoplay: true)
        } else if ended { pause() }
        persist(); publish()
    }
    private func tick() {
        let decision = sleepState.decision(at: Date().timeIntervalSince1970 * 1000)
        if decision.stop { finishSleep(); return }
        audio.volume = Float(decision.gain)
        checkRecovery()
    }
    // Runs natively while background audio is active, and immediately on foreground.
    private func checkRecovery() {
        guard wantsPlayback, !audioActivationPending, audio.currentItem != nil else { return }
        let position = audio.currentTime().seconds
        if position.isFinite && position > lastPosition + 0.05 {
            lastPosition = position
            lastProgressAt = Date(); failureDetectedAt = nil; retryAt = nil
            if recoveringPlayback { diagnostic("recovered"); recoveringPlayback = false; errorMessage = "" }
            recoveryAttempts = 0
            return
        }
        if retryAt == nil {
            let delay = NativeRetry.delay(attempt: recoveryAttempts, confirmedFailure: failureDetectedAt != nil,
                jitter: Double.random(in: 0...1))
            retryAt = (failureDetectedAt ?? lastProgressAt).addingTimeInterval(delay)
        }
        guard let deadline = retryAt, Date() >= deadline else { return }
        // A malformed/unsupported local file is bypassed after one failure. Even if the
        // streaming fallback also fails, stop visibly instead of reloading forever.
        if recoveryAttempts >= 8 {
            wantsPlayback = false; recoveringPlayback = false
            audio.pause()
            errorMessage = skipLocalForCurrentTrack
                ? "本地音频不可播放，联网恢复失败，请重新选择重试"
                : "音频连接失败；离线且未缓存，无法播放，请联网后重试"
            publish(); return
        }
        if case .cached = playbackSource { skipLocalForCurrentTrack = true }
        recoveryAttempts += 1
        diagnostic("retry", detail: "attempt=\(recoveryAttempts)")
        loadCurrent(autoplay: true, at: lastPosition, recovering: true)
    }
    private func diagnostic(_ event: String, detail: String = "") {
        // Do not write server URLs, query tokens, or song titles to diagnostics.
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(event) pos=\(pos) time=\(lastPosition) wants=\(wantsPlayback) status=\(audio.timeControlStatus.rawValue) \(detail)"
        switch event {
        case "setup", "load", "foreground", "background", "pause":
            if verboseDiagnostics { logger.debug("[Playback] \(line, privacy: .public)") }
        case "item-failed", "activation-failed":
            logger.error("[Playback] \(line, privacy: .public)")
        default:
            logger.notice("[Playback] \(line, privacy: .public)")
        }
        logQueue.async {
            guard let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
            let url = directory.appendingPathComponent("playback.log")
            do {
                var data = (try? Data(contentsOf: url)) ?? Data()
                data.append(Data((line + "\n").utf8))
                if data.count > 256 * 1024 { data = Data(data.suffix(128 * 1024)) }
                try data.write(to: url, options: .atomic)
            } catch { self.logger.error("Cannot write playback log: \(error.localizedDescription, privacy: .public)") }
        }
    }
    private func finishSleep() {
        // Pause before restoring normal volume so no full-volume tail escapes.
        audioActivationToken = UUID(); audioActivationPending = false
        recoveringPlayback = false
        wantsPlayback = false; resumeAfterInterruption = false; audio.pause()
        sleepState.finish()
        audio.volume = 1; persist(); publish()
    }
    private func activateSession() {
        if #available(iOS 16.0, *), let session = sessionStorage as? MPNowPlayingSession,
           !session.isActive, session.canBecomeActive, !activationPending {
            activationPending = true
            session.becomeActiveIfPossible { [weak self] _ in DispatchQueue.main.async { self?.activationPending = false } }
        }
    }
    private func bind(_ command: MPRemoteCommand, action: @escaping () -> Bool) {
        command.isEnabled = true
        targets.append((command, command.addTarget { [weak self] _ in self?.onMain(action) ?? .commandFailed }))
    }
    private func onMain(_ work: @escaping () -> Bool) -> MPRemoteCommandHandlerStatus {
        let run = { () -> MPRemoteCommandHandlerStatus in let result = work(); self.persist(); self.publish(); return result ? .success : .commandFailed }
        return Thread.isMainThread ? run() : DispatchQueue.main.sync(execute: run)
    }
    private func snapshot(includeCatalog: Bool = true, progressOnly: Bool = false) -> [String: Any] {
        let time = audio.currentTime().seconds
        let duration = audio.currentItem?.duration.seconds ?? 0
        if duration.isFinite && duration > 0 { lastKnownDuration = duration }
        let recovering = recoveringPlayback && wantsPlayback
        let displayTime = (recovering || resolvingCache) ? max(lastPosition, time.isFinite ? time : 0) : (time.isFinite ? time : 0)
        let displayDuration = recovering ? lastKnownDuration : (duration.isFinite ? duration : 0)
        var state: [String: Any] = ["pos": pos,
                "shuffle": shuffle, "repeatOne": repeatOne, "skipSame": skipSame, "rate": rate, "revision": revision, "sequence": sequence,
                "position": displayTime, "duration": displayDuration,
                "playing": audio.timeControlStatus == .playing, "loading": (resolvingCache && wantsPlayback) || recovering || audioActivationPending || audio.timeControlStatus == .waitingToPlayAtSpecifiedRate,
                "error": errorMessage, "sleepUntil": sleepState.until as Any? ?? NSNull(), "sleepStarted": sleepState.started as Any? ?? NSNull(),
                "supportsCustomSleep": true, "sleepCustomVersion": 1, "sleepCustom": sleepState.custom.dictionary,
                "sleepRevision": sleepState.revision, "sleepMode": sleepState.mode, "afterTrack": sleepState.afterTrack, "sleepFired": sleepState.fired]
        if !progressOnly {
            state["history"] = history; state["redo"] = redo; state["played"] = played
        }
        if includeCatalog { state["queue"] = queue.map { item in item.filter { $0.key != "lyrics" } } }
        return state
    }
    private func publish(progressOnly: Bool = false) {
        sequence += 1
        let state = snapshot(includeCatalog: false, progressOnly: true)
        if queue.indices.contains(pos) {
            let track = queue[pos]
            let title = track["title"] as? String ?? "安允日记"
            let lyric = NativeLyrics.currentLine(track["lyrics"] as? [[String: Any]] ?? [],
                position: state["position"] as? Double ?? 0,
                duration: (track["clipDuration"] as? NSNumber)?.doubleValue ?? 0)
            let metadata: [String: Any] = [MPMediaItemPropertyTitle: lyric ?? title,
                MPMediaItemPropertyArtist: lyric == nil ? "安允日记" : title,
                MPMediaItemPropertyAlbumTitle: track["album"] as? String ?? "安允日记",
                MPNowPlayingInfoPropertyElapsedPlaybackTime: state["position"] ?? 0,
                MPMediaItemPropertyPlaybackDuration: state["duration"] ?? 0,
                MPNowPlayingInfoPropertyPlaybackRate: audio.rate]
            let previous = infoCenter.nowPlayingInfo ?? [:]
            let changed = metadata.contains { key, value in
                if key == MPNowPlayingInfoPropertyElapsedPlaybackTime { return false }
                return !NSDictionary(dictionary: [key: value]).isEqual(to: [key: previous[key] as Any])
            }
            let previousTime = previous[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double ?? -10
            if changed || abs((state["position"] as? Double ?? 0) - previousTime) >= 5 {
                infoCenter.nowPlayingInfo = metadata
            }
        } else { infoCenter.nowPlayingInfo = nil }
        // Background playback/lyrics stay native. Foreground refresh gets a full snapshot.
        let now = Date()
        if UIApplication.shared.applicationState == .active && (!progressOnly || now.timeIntervalSince(lastProgressSent) >= 0.5) {
            notifyListeners("state", data: snapshot(includeCatalog: catalogDirty, progressOnly: progressOnly && !catalogDirty))
            catalogDirty = false
            lastProgressSent = now
        }
        if now.timeIntervalSince(lastSave) >= 30 { persist() }
    }
    private func persist() {
        lastSave = Date()
        var saved = snapshot()
        saved["queue"] = queue
        // UserDefaults property lists do not accept NSNull.
        if saved["sleepUntil"] is NSNull { saved.removeValue(forKey: "sleepUntil") }
        if saved["sleepStarted"] is NSNull { saved.removeValue(forKey: "sleepStarted") }
        // Audio snapshots may contain null duration; JSON data preserves that safely.
        // A failed migration must not replace the previous legacy record.
        guard let data = try? JSONSerialization.data(withJSONObject: queue) else { return }
        saved["queueJSON"] = data
        saved.removeValue(forKey: "queue")
        UserDefaults.standard.set(saved, forKey: savedKey)
    }
}

@available(iOS 16.0, *)
extension NativePlaybackPlugin: MPNowPlayingSessionDelegate {
    public func nowPlayingSessionDidChangeActive(_ nowPlayingSession: MPNowPlayingSession) { }
    public func nowPlayingSessionDidChangeCanBecomeActive(_ nowPlayingSession: MPNowPlayingSession) { activateSession() }
}
