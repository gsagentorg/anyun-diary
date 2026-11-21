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
ok(disk.includes('jsonRequests[candidate.key] = nil') && disk.includes('entries[key] = nil\n        jsonRequests[key] = nil'), 'eviction/invalidation revoke JSON validators');
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
console.log('native-offline: ' + checks + ' source contracts passed (NOT Swift execution)');
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
