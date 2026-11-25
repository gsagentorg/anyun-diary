#!/usr/bin/env node
// Source-contract checks on every host; real Swift behavior tests only on macOS.
// --require-swift makes missing macOS/Swift a failure (release gate, never a silent pass).
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const disk = read('ios/App/App/AnyunDiskCache.swift');
const lease = read('ios/App/App/AnyunPlaybackCache.swift');
const playback = read('ios/App/App/NativePlayback.swift');
const network = read('ios/App/App/AnyunCacheNetwork.swift');
const scheme = read('ios/App/App/AnyunCacheSchemeHandler.swift');
const plugin = read('ios/App/App/AnyunCachePlugin.swift');
const swiftTests = read('scripts/test-native-cache.swift');
let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
const body = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'unique source sections exist');
  return source.slice(a, b);
};
const lookup = body(disk, 'func acquirePlaybackLease(', 'func releasePlaybackLeases(');
ok(lookup.includes('ensureIndexLoaded()') && lookup.includes('validatedEntry(key: key)'), 'native hit must come from validated index, not an orphan bin');
ok(lookup.includes('AnyunMediaFileValidation.isCompleteOpus') && lookup.includes('refreshLease'), 'format/framing integrity precedes lease creation');
ok(lookup.includes('_ = lookup(key: key)'), 'native cache hits touch LRU');
ok(lookup.includes('prunePlaybackLeases()'), 'every acquired lease prunes history');
ok(disk.includes('actual == file.bytes') && network.includes('Int64(bytes) != expectedBytes'), 'actual file bytes AND declared HTTP length checked');
ok(network.includes('http.statusCode == 200') && network.includes('"Content-Range") == nil'), 'partial responses cannot masquerade as full files');
ok(network.includes('createFile(atPath: destination.path'), 'stream sink creates destination before opening FileHandle');
ok(network.includes('bytes > maxBytes') && network.includes('declared > Int64(maxBytes)'), 'both declared and streamed size bounded');
ok(network.includes('mediaResourceTimeout: TimeInterval = 600') && network.includes('mediaIdleTimeout: TimeInterval = 30'), 'native transfer has resource and idle limits');
ok(disk.includes('expectedMediaEpoch != mediaEpoch') && disk.includes('mediaEpoch += 1'), 'clear invalidates even a prefetch scheduled after its lookup');
ok(disk.includes('inFlightFiles[key]?.id == slotID') && disk.includes('releaseFileSlot'), 'old worker never commits/releases a new slot');
ok(disk.includes('cancelFileDownloads(except: key)') && disk.includes('slot.task.cancel()'), 'track switches cancel the obsolete prefetch lane');
ok(disk.includes('try Task.checkCancellation()'), 'canceled subscriber does not receive a usable stale result');
ok(!lease.includes('createSymbolicLink') && !lease.includes('return media'), 'hard-link failure is a miss, never an unsafe fallback');
ok(lease.includes('prefix(2)') && disk.includes('recentLeaseKeys'), 'lease retention bounded to current plus previous');
ok(disk.includes('skippedKeys.count >= 128'), 'oversize skip memory bounded');
ok(disk.includes('guard crc == storedCRC') && disk.includes('return !first && ended && consumed == bytes'), 'Ogg CRC, page framing and EOS validated');
ok(!playback.includes('prefetchFailedKeys'), 'transient failures are not permanently blacklisted');
ok(playback.includes('!prefetchAttempted') && playback.includes('prefetchAttempted = false; skipLocalForCurrentTrack = false'), 'explicit reselection permits one fresh attempt');
const loading = body(playback, 'private func loadCurrent(', 'private func attach(');
ok(loading.includes('Task { @MainActor') && loading.includes('await AnyunPlaybackCache.shared.localPlaybackURL'), 'filesystem lease lookup is async, not main-thread IO');
ok(loading.includes('self.loadGeneration == generation') && loading.includes('!Task.isCancelled'), 'late lookup cannot attach a previous track');
ok(loading.includes('self.wantsPlayback && !self.expired && !self.sleepState.fired'), 'late cache hit respects pause and sleep intent');
ok(loading.includes('at: self.lastPosition'), 'seek while lookup pending is honored');
const prefetch = body(playback, 'private func startPrefetch(', 'private static func keyPrefix(');
ok(!prefetch.includes('audio.play') && !prefetch.includes('replaceCurrentItem'), 'prefetch completion never resumes paused playback');
ok(playback.includes('recoveryAttempts >= 8') && playback.includes('skipLocalForCurrentTrack = true'), 'local decoder failure bypasses cache and retries are finite');
ok(playback.includes('case .streaming') && playback.includes('离线且未缓存，无法播放'), 'offline uncached state has an explicit message');
ok(scheme.includes('revalidatingKeys.insert(key).inserted') && scheme.includes('revalidateMedia(key: key, original: entry'), 'legacy scheme refresh is deduplicated and fenced against replacement');
const beginJSON = body(disk, 'func beginJSONRequest(', 'func finishJSONRequest(');
const validateJSON = body(disk, 'private func validateJSONRequest(', '/// Both ownership validation');
const storeJSON = body(disk, 'func storeJSON(', '/// A 304 only confirms');
const confirmJSON = body(disk, 'func revalidateJSON(', '/// 304：');
const clearJSON = body(disk, 'func clear(scope:', 'func stats(');
ok(beginJSON.includes('lookup(key: key)') && beginJSON.includes('read(key: key)') && beginJSON.includes('jsonRequests[key] = id'), 'JSON ownership and cached snapshot acquired atomically before network');
ok(validateJSON.includes('request.epoch == jsonEpoch') && validateJSON.includes('jsonRequests[request.key] == request.id'), 'JSON commit checks both scoped epoch and latest request UUID');
for (const section of [storeJSON, confirmJSON]) {
  ok(section.includes('try validateJSONRequest(request)') && !section.includes('await '), 'JSON 200/304 validation and mutation share one actor turn');
}
ok(!disk.includes('func storeJSON(key:'), 'no unfenced JSON store overload remains');
ok(confirmJSON.includes('request.entry != nil') && confirmJSON.includes('let data = request.data') && confirmJSON.includes('validatedEntry(key: request.key)?.kind == .json'), '304 requires original JSON snapshot, never reads new bytes');
ok(clearJSON.includes('if touchesJson {\n            jsonEpoch += 1\n            jsonRequests.removeAll()\n        }') && (disk.match(/jsonEpoch \+= 1/g) ?? []).length === 1, 'only JSON/all clear advances JSON request epoch');
ok(disk.includes('if jsonRequests[request.key] == request.id { jsonRequests[request.key] = nil }'), 'old request cleanup cannot clear newer ownership');
ok(disk.includes('jsonRequests[candidate.key] = nil') && /entries\[key\] = nil\s+forgetMediaProbe\(key\)\s+jsonRequests\[key\] = nil/.test(disk), 'eviction/invalidation revoke JSON validators');
const foregroundJSON = body(plugin, '@objc public func fetchJSON(', '// MARK: - 内部');
const backgroundJSON = body(plugin, 'private func revalidateJSON(', 'static func jsonObject(');
ok(foregroundJSON.indexOf('beginJSONRequest(key: key)') < foregroundJSON.indexOf('self.network.get('), 'foreground acquires ownership before network');
ok(foregroundJSON.includes('self.revalidateJSON(request: request, url: url, entry: entry)'), 'SWR transfers existing ownership instead of acquiring after clear');
for (const section of [foregroundJSON, backgroundJSON]) {
  ok(/storeJSON\(\s*request: request,/.test(section) && section.includes('disk.revalidateJSON(request: request)'), 'foreground/background 200 and 304 use actor-fenced request');
  ok(section.includes('finishJSONRequest(request)'), 'JSON request releases ownership on completion/failure');
}
ok(!plugin.includes('markRevalidated(') && !plugin.includes('disk.read(key:') && !plugin.includes('disk.lookup(key:'), 'plugin cannot apply old validator to newer entry or mix snapshot ages');
for (const name of ['testPlaybackLeaseSerializationAndCorruption', 'testFileClearAndLaneCancellation', 'testScopedClearAndRevalidateABA', 'testJSONRequestOwnership']) {
  ok(swiftTests.includes('await ' + name + '()') && swiftTests.includes('static func ' + name + '('), name + ' is actually invoked');
}
for (const scenario of ['late JSON 200 cannot resurrect', 'old 304 cannot reset replacement age', 'older request loses before latest commits', 'failed newest request never re-enables old writer', 'valid 304 returns its own atomic snapshot', 'identical replacement invalidates old 304 ownership', 'eviction cannot be undone by late SWR 200']) {
  ok(swiftTests.includes(scenario), 'Swift actor regression scenario present: ' + scenario);
}
ok(!swiftTests.includes('while !await'), 'async loop uses parenthesized await');
ok(!swiftTests.includes('Data("stale")') && !swiftTests.includes('Data("orphan bytes")'), 'String fixtures explicitly use UTF-8 bytes');
const nativeRefresh = body(playback, 'private func startMediaRefresh(', 'private static func keyPrefix(');
const staleRefresh = body(disk, 'func refreshMediaFileIfStale(', 'private func commitMediaRefresh(');
const commitRefresh = body(disk, 'private func commitMediaRefresh(', 'private func commitFile(');
const statusProbe = body(disk, 'func mediaStatus(urls:', '/// Do not call ensureIndexLoaded:');
const probeSnapshot = body(disk, 'private func mediaProbeEntries(', '/// Read-only observability;');
const throwingValidation = body(disk, 'static func completeOpus(handle:', '/// POSIX nanosecond identity');
const statusBridge = body(plugin, '@objc public func mediaStatus(', '// MARK: - fetchJSON');
ok(loading.indexOf('self.attach(AVPlayerItem(url: local)') < loading.indexOf('self.startMediaRefresh('), 'AVPlayer hit attaches before background refresh scheduling');
ok(nativeRefresh.includes('Task.detached') && nativeRefresh.includes('refreshMediaFileIfStale') && nativeRefresh.includes('etag: entry.etag, lastModified: entry.lastModified'), 'real AVPlayer hit uses conditional streaming refresh');
ok(!/replaceCurrentItem|audio[.]play|self[.]attach|self[.]seek|wantsPlayback =/.test(nativeRefresh), 'native refresh cannot reinstall, seek or resume current item');
ok(staleRefresh.includes('now - original.createdAt > Double(policyProvider().mediaRevalidateSeconds)'), 'media refresh starts only strictly beyond configured age');
ok(staleRefresh.includes('inFlightFiles[key] == nil') && staleRefresh.includes('mediaRefreshCooldown') && disk.includes('mediaRefreshAttempts.count >= 128'), 'refresh dedupe and bounded cooldown');
ok(staleRefresh.includes('onCancel: { worker.cancel() }') && staleRefresh.includes('cancelFileDownloads(except: key)'), 'refresh cancellation reaches shared file lane and waits for old cleanup');
ok(commitRefresh.includes('mediaRefreshOwners[key] == slotID') && commitRefresh.includes('mediaEpoch == capturedEpoch') && commitRefresh.includes('task.isCancelled == false'), 'SWR commit checks ownership epoch and cancellation');
const notModified = body(commitRefresh, 'if file.notModified {', 'return try commitFile(');
ok(notModified.includes('entry.createdAt =') && !notModified.includes('entry.lastAccess =') && !notModified.includes('entry.etag ='), 'native 304 changes only original age, not LRU/content/validators');
ok(disk.includes('Darwin.rename(file.fileURL.path, target.path) == 0'), 'full 200 atomically replaces file without first deleting old bytes');
ok(network.includes('http.statusCode == 304, allowsNotModified') && network.includes('if notModified {') && network.includes('304 must never deliver a body'), 'stream delegate handles validated empty 304 explicitly');
ok(plugin.includes('CAPPluginMethod(name: "mediaStatus"') && statusBridge.includes('"statuses": statuses'), 'mediaStatus is registered with agreed response envelope');
ok(statusBridge.includes('urls.count <= 100') && statusProbe.includes('urls.count <= 100'), 'bridge and actor enforce batch bound');
ok(lease.includes('url.query == nil') && lease.includes('url.user == nil') && lease.includes('url.fragment == nil'), 'status accepts stable HTTPS sources, never signed or credential targets');
ok(statusProbe.includes('try AnyunMediaFileValidation.completeOpus(handle:') && !/validatedEntry|ensureIndexLoaded|invalidate[(]|persistIndex|refreshLease|acquirePlaybackLease|lookup[(]key|downloadFile[(]|network|URLSession|Task[.]detached/.test(statusProbe), 'mediaStatus full integrity probe never repairs index or touches leases/LRU/network');
ok(probeSnapshot.includes('if indexLoaded { return entries }') && probeSnapshot.includes('try Data(contentsOf: indexPath)') && !/ensureIndexLoaded|ensureDirectory|sweepLeftovers|evict[(]|persistIndex|indexLoaded =|entries =/.test(probeSnapshot), 'cold status snapshot does no maintenance or index mutation');
ok(statusProbe.includes('before.isRegular, before.size == Int64(entry.bytes)') && statusProbe.includes('fingerprint(url) else { return false }'), 'only definite absent/invalid length files become misses');
ok(statusProbe.includes('throw error') && probeSnapshot.includes('throw error') && !/try[?].*(fingerprint|read|FileHandle)/.test(statusProbe + probeSnapshot), 'stat/open/read errors propagate rather than becoming false');
ok(statusBridge.includes('catch { call.reject("缓存状态查询不可用", "UNAVAILABLE") }'), 'actor IO failures reject bridge status as UNAVAILABLE');
ok(throwingValidation.includes('try handle.read(') && !/catch|try[?]/.test(throwingValidation), 'throwing framing validator preserves read failures');
ok(disk.includes('return (try? completeOpus(handle: handle, bytes: bytes)) ?? false'), 'legacy Bool validator preserves nonprobe false-on-IO API');
ok(statusProbe.includes('memo.entry == entry, memo.fingerprint == before') && statusProbe.includes('complete = memo.complete'), 'both positive and negative memo results require exact entry and fingerprint');
ok(statusProbe.includes('FileHandle(forReadingFrom: url)') && statusProbe.includes('try handle.read(upToCount: 1)'), 'every memo result reopens and reads actual bytes for protection/ACL checks');
ok((statusProbe.match(/fingerprint\(handle\) == before/g) ?? []).length === 2 && statusProbe.includes('fingerprint(url) == before else { throw'), 'probe validates path and opened inode before and after reads');
for (const field of ['st_dev', 'st_ino', 'st_size', 'st_mtimespec.tv_sec', 'st_mtimespec.tv_nsec', 'st_ctimespec.tv_sec', 'st_ctimespec.tv_nsec', 'st_mode', 'st_uid', 'st_gid', 'st_flags']) ok(disk.includes(field), 'memo fingerprint includes ' + field);
ok(disk.includes('Darwin.lstat') && disk.includes('Darwin.fstat') && disk.includes('code == ENOENT || code == ENOTDIR'), 'POSIX missing classification distinguishes transient stat failures');
ok(disk.includes('mediaProbeMemoLimit = 4096') && statusProbe.includes('mediaProbeMemoOrder.count >= Self.mediaProbeMemoLimit') && statusProbe.includes('mediaProbeMemoOrder.removeFirst()'), 'verification memo has bounded FIFO memory');
ok((disk.match(/forgetMediaProbe\(key\)/g) ?? []).length === 4 && disk.includes('forgetMediaProbe(candidate.key)') && disk.includes('forgetMediaProbe(victim.key)') && clearJSON.includes('mediaProbeMemos.removeAll()'), 'invalidate/store/file replace/evict/prune/clear revoke verification memo');
ok(!/\bprint[(]|\blogger\b|\bdiagnostic\b/.test(statusBridge + statusProbe + probeSnapshot), 'status URLs never logged');
for (const name of ['testNativeMediaSWR', 'testMediaStatus', 'testMediaStatusReadOnlyAndMemo', 'testMediaStatusMemoBound']) ok(swiftTests.includes('await ' + name + '()') && swiftTests.includes('static func ' + name + '('), 'actual Swift regression entry: ' + name);
for (const label of ['fresh/exact-window hit never requests network', 'native SWR full 200 replaces complete cache', 'same-key stale refresh is deduplicated', 'late 200/304 cannot revive or overwrite:', 'mediaStatus rejects CRC-corrupt same-length media']) ok(swiftTests.includes(label), 'Swift scenario: ' + label);
ok(staleRefresh.indexOf('mediaRefreshOwners[key] = slotID') < staleRefresh.indexOf('await cancelFileDownloads'), 'SWR ownership acquired before actor suspension (ABA-safe)');
for (const label of ['repeat positive probes never rescan CRC', 'repeat negative probes never rescan CRC', 'protected negative memo must throw rather than reuse false', 'same-inode same-length corruption invalidates positive memo', 'atomic inode replacement invalidates negative memo', 'temporary open permission failure must throw', 'temporary stat permission failure must throw', 'read failure must throw instead of false', 'definite missing file never removes index', 'cold probe never repairs index sweeps or evicts', 'cold protected index must throw', 'entry replacement invalidates memo', 'eviction never reuses positive memo', 'clear releases memo memory', 'probe memo memory is bounded']) ok(swiftTests.includes(label), 'Swift probe regression: ' + label);

// —— #17：预算记账、audio-first 淘汰、IO 失败与「上报占用 = 真实可用」——
const evictBody = body(disk, 'private func evict(protecting', '/// 写盘空间不足时的单步让步');
ok(evictBody.includes('if lhs.kind != rhs.kind { return lhs.kind == .media }') && evictBody.includes('lhs.lastAccess < rhs.lastAccess'), 'audio-first eviction keeps LRU ordering within each kind');
ok(evictBody.includes('if total <= policy.maxBytes && count <= policy.maxEntries { break }'), 'eviction stops as soon as both budgets fit');
const storeUnlockedBody = body(disk, 'private func storeUnlocked(', 'func beginJSONRequest(');
ok(storeUnlockedBody.includes('AnyunDiskCacheFailure.isOutOfSpace(error)') && storeUnlockedBody.includes('dropOldestUnprotected'), 'only out-of-space retries after freeing LRU space');
ok(storeUnlockedBody.indexOf('try payload.data.write') < storeUnlockedBody.indexOf('entries[key] = entry'), 'index mutates only after the file write succeeded');
const statsBody = body(disk, 'func stats() -> AnyunCacheStats', '/// 设置面板选定上限后立刻生效');
ok(statsBody.indexOf('pruneUnavailableEntries()') < statsBody.indexOf('evict(protecting: nil)'), 'stats prunes phantom entries before reporting usage');
const pruneBody = body(disk, 'private func pruneUnavailableEntries(', '// MARK: - 索引与淘汰');
ok(pruneBody.includes('catch { continue }') && pruneBody.includes('fingerprint.isRegular, fingerprint.size == Int64(entry.bytes)'), 'usage pruning never treats a transient stat failure as a system purge');
const validatedBody = body(disk, 'private func validatedEntry(', 'private func forgetMediaProbe(');
ok(validatedBody.includes('catch { return nil }') && validatedBody.includes('invalidate(key: key)'), 'transient stat failure is a miss; only definite absence/size mismatch invalidates');
ok(disk.includes('func enforcePolicy()') && plugin.includes('await self.disk.enforcePolicy()'), 'policy changes are enforced immediately by the bridge');
for (const name of ['testEvictionOrderBudgetAndAgreement', 'testStorageIOFailureDegradesGracefully']) {
  ok(swiftTests.includes('await ' + name + '()') && swiftTests.includes('static func ' + name + '('), name + ' is actually invoked');
}
for (const label of ['audio leaves before metadata under budget pressure', 'selected preset is enforced immediately', 'metadata alone is never pinned past the budget', 'reported usage equals actually available media', 'system purge cannot leave phantom usage', 'out-of-space-only retry never evicts on unrelated IO errors', 'permission write failure keeps the old complete entry', 'playback lease survives failed cache write', 'transient stat failure is a miss, not a valid hit', 'transient stat failure never prunes reported usage', 'cache entry survives a transient stat failure']) ok(swiftTests.includes(label), 'Swift #17 scenario: ' + label);
console.log('native-offline: ' + checks + ' source contracts passed (NOT Swift execution)');
const sleepGate = spawnSync(process.execPath, ['scripts/test-native-sleep.mjs', ...(process.argv.includes('--require-swift') ? ['--require-swift'] : [])], { cwd: root, encoding: 'utf8', timeout: 120000 });
process.stdout.write(sleepGate.stdout || ''); process.stderr.write(sleepGate.stderr || '');
assert.equal(sleepGate.status, 0, 'native sleep gate failed (no automatic retry): ' + (sleepGate.error || ''));
const inputs = ['AnyunCacheConstants.swift', 'AnyunCacheNetwork.swift', 'AnyunDiskCache.swift', 'AnyunPlaybackCache.swift', 'AnyunCacheSchemeHandler.swift'].map(name => 'ios/App/App/' + name);
const compiler = process.platform === 'darwin' ? spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }) : null;
if (!compiler || compiler.status !== 0) {
  console.log('SKIP: macOS Swift/WebKit unavailable; Swift behavior/compilation and iPhone playback remain UNVERIFIED.');
  if (process.argv.includes('--require-swift')) process.exitCode = 1;
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'anyun-native-offline-'));
  try {
    const executable = join(temporary, 'cache-tests');
    const target = (process.arch === 'arm64' ? 'arm64' : 'x86_64') + '-apple-macosx12.0';
    const args = ['-swift-version', '5', '-strict-concurrency=minimal', '-parse-as-library', '-target', target, ...inputs, 'scripts/test-native-cache.swift', '-o', executable];
    const compiled = spawnSync(compiler.stdout.trim(), args, { cwd: root, encoding: 'utf8', timeout: 90000 });
    process.stdout.write(compiled.stdout || ''); process.stderr.write(compiled.stderr || '');
    assert.equal(compiled.status, 0, 'Swift compile failed (no automatic retry): ' + (compiled.error || ''));
    const result = spawnSync(executable, [], { cwd: root, encoding: 'utf8', timeout: 30000 });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    assert.equal(result.status, 0, 'Swift behavior test failed: ' + (result.error || ''));
    console.log('native-offline: Swift actor/filesystem behavior tests passed on macOS; AVPlayer/device still unverified.');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
