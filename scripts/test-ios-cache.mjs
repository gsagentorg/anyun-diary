#!/usr/bin/env node
/**
 * test-ios-cache.mjs — iOS 原生缓存的「静态契约断言」。
 *
 * 本机 Linux 没有 swiftc/Xcode，Swift 代码无法编译；这里只做能在无编译器环境下成立的检查：
 *   1. Swift 文件存在且带「未编译未真机」标记；
 *   2. Swift 里的 scheme / host / 插件名 / 方法名 / 策略默认值与夹取范围，和网页侧
 *      src/lib/native-cache.ts 的常量逐项一致；
 *   3. 6 个 Swift 文件都真的进了 Xcode 工程（fileRef + buildFile + group + Sources），
 *      id 唯一、无悬空引用、大括号配平；
 *   4. 接线存在：scheme handler 注册在 AnyunCacheConstants.scheme 上，SceneDelegate 用
 *      AnyunBridgeViewController，插件注册在 capacitorDidLoad 里；
 *   5. 不出现明文 http 资源地址或凭据形态的字符串。
 *
 * 它不能替代真机测试：编译错误、WebKit 对自定义 scheme 的媒体支持、Range 行为都不在此覆盖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const appDir = path.join(root, 'ios/App/App');
const swifts = [
  'AnyunCacheConstants.swift',
  'AnyunDiskCache.swift',
  'AnyunCacheNetwork.swift',
  'AnyunCacheSchemeHandler.swift',
  'AnyunCachePlugin.swift',
  'AnyunBridgeViewController.swift',
  'AnyunPlaybackCache.swift',
];
const tsSource = fs.readFileSync(path.join(root, 'src/lib/native-cache.ts'), 'utf8');
const pbx = fs.readFileSync(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
const scene = fs.readFileSync(path.join(appDir, 'SceneDelegate.swift'), 'utf8');

let checks = 0;
const ok = (value, message) => {
  assert.ok(value, message);
  checks++;
};
const eq = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  checks++;
};

const source = Object.fromEntries(swifts.map((name) => [name, fs.readFileSync(path.join(appDir, name), 'utf8')]));
const all = Object.values(source).join('\n');
const core = source['AnyunCacheConstants.swift'];
const plugin = source['AnyunCachePlugin.swift'];
const handler = source['AnyunCacheSchemeHandler.swift'];
const bridge = source['AnyunBridgeViewController.swift'];
const disk = source['AnyunDiskCache.swift'];
const network = source['AnyunCacheNetwork.swift'];
const lease = source['AnyunPlaybackCache.swift'];
const playback = fs.readFileSync(path.join(appDir, 'NativePlayback.swift'), 'utf8');

// —— 1. 文件与免责标记 ——
for (const name of swifts) {
  ok(source[name].length > 0, `${name}: 存在且非空`);
  ok(/UNVERIFIED: 未在 macOS\/Xcode 编译/.test(source[name]), `${name}: 标注未编译未真机`);
}

// —— 2. 与网页侧常量逐项一致 ——
const tsString = (name) => {
  const match = tsSource.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`));
  return match?.[1];
};
const swiftString = (name) => {
  const match = core.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
  return match?.[1];
};
eq(swiftString('scheme'), tsString('NATIVE_CACHE_SCHEME'), 'scheme 与 TS 一致');
eq(swiftString('mediaHost'), tsString('NATIVE_CACHE_HOST'), 'media host 与 TS 一致');
eq(tsString('NATIVE_CACHE_SCHEME'), 'anyun-cache', 'scheme 字面量');
eq(tsString('NATIVE_CACHE_PLUGIN'), 'AnyunCache', '插件 jsName 字面量');
ok(plugin.includes('let jsName = "AnyunCache"'), 'Swift 插件 jsName = AnyunCache');
ok(plugin.includes('let identifier = "AnyunCachePlugin"'), 'Swift 插件 identifier = AnyunCachePlugin');
ok(core.includes('policyDefaultsKey = "anyun.cache.policy.v1"'), '策略持久化键与文档一致');

// 方法名：TS 列表 ⇄ Swift CAPPluginMethod(name:) 双向覆盖
const tsMethods = [...tsSource.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
const declared = ['configure', 'stats', 'clear', 'setPolicy', 'fetchJSON', 'mediaStatus'];
const swiftMethods = [...plugin.matchAll(/CAPPluginMethod\(name: "([a-zA-Z]+)"/g)].map((m) => m[1]);
eq([...swiftMethods].sort().join(','), [...declared].sort().join(','), 'Swift 暴露的方法集合与契约一致');
for (const name of declared) {
  ok(tsSource.includes(`'${name}'`) || name === 'configure', `TS 常量列表包含 ${name}`);
  ok(new RegExp(`func ${name}\\(_ call: CAPPluginCall\\)`).test(plugin), `Swift 实现 ${name}(_ call:)`);
  ok(tsMethods.length > 0, 'TS 方法名字面量可读');
}

// 策略默认值：四个数字必须同时出现在 Swift 与 TS
const defaults = [536870912, 4000, 604800, 60];
for (const value of defaults) {
  ok(core.includes(String(value)), `Swift 含默认值 ${value}`);
  ok(tsSource.includes(String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '_')) || tsSource.includes(String(value)), `TS 含默认值 ${value}`);
}
const ranges = [16777216, 4294967296, 64, 20000, 3600, 2592000, 5];
for (const value of ranges) {
  ok(core.includes(String(value)), `Swift 含夹取边界 ${value}`);
}
// TS 侧的边界写成带下划线的形式，统一去下划线后比对
const tsPlain = tsSource.replace(/_/g, '');
for (const value of [16777216, 4294967296, 64, 20000, 3600, 2592000, 5]) {
  ok(tsPlain.includes(String(value)), `TS 含夹取边界 ${value}`);
}

// —— 3. Xcode 工程接线 ——
const ids = [...pbx.matchAll(/^\t\t([0-9A-F]{24}) /gm)].map((m) => m[1]);
eq(new Set(ids).size, ids.length, 'pbxproj 的 24 位 id 无重复');
for (const name of swifts) {
  const fileRef = new RegExp(`[0-9A-F]{24} /\\* ${name.replace(/\./g, '\\.')} \\*/ = \\{isa = PBXFileReference;[^}]*path = ${name.replace(/\./g, '\\.')};`);
  ok(fileRef.test(pbx), `${name}: 有 PBXFileReference`);
  ok(pbx.includes(`${name} in Sources */ = {isa = PBXBuildFile;`), `${name}: 有 PBXBuildFile`);
  const buildId = pbx.match(new RegExp(`([0-9A-F]{24}) /\\* ${name} in Sources \\*/ = \\{isa = PBXBuildFile;`))?.[1];
  ok(!!buildId && pbx.includes(`${buildId} /* ${name} in Sources */,`), `${name}: 在 Sources build phase`);
  const refId = pbx.match(new RegExp(`([0-9A-F]{24}) /\\* ${name} \\*/ = \\{isa = PBXFileReference;`))?.[1];
  ok(!!refId && pbx.includes(`${refId} /* ${name} */,`), `${name}: 在 App group children`);
  ok(pbx.includes(`fileRef = ${refId} /* ${name} */;`), `${name}: buildFile 指向自己的 fileRef`);
}
const opens = (pbx.match(/\{/g) ?? []).length;
const closes = (pbx.match(/\}/g) ?? []).length;
eq(opens, closes, 'pbxproj 大括号配平');
ok(scene.includes('AnyunBridgeViewController()'), 'SceneDelegate 使用 AnyunBridgeViewController');
ok(bridge.includes('override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration)'), 'Bridge 覆写 webViewConfiguration(for:)');
ok(/setURLSchemeHandler\(handler, forURLScheme: AnyunCacheConstants\.scheme\)/.test(bridge), 'scheme handler 注册在约定 scheme 上');
ok(bridge.includes('registerPluginInstance(AnyunCachePlugin())'), '插件在 bridge 里注册');
ok(/capacitorDidLoad\(\)/.test(bridge), '注册发生在 capacitorDidLoad');

// —— 4. scheme / SWR 语义的静态痕迹 ——
ok(handler.includes('WKURLSchemeHandler'), 'scheme handler 实现 WKURLSchemeHandler');
ok(handler.includes('"Content-Range"'), '支持 Range → Content-Range');
ok(handler.includes('"Accept-Ranges"'), '声明 Accept-Ranges');
ok(handler.includes('mediaRevalidateSeconds'), '音频 revalidate 使用策略窗口');
ok(plugin.includes('"stale"') && plugin.includes('"offline"'), 'fetchJSON 返回 stale/offline 语义');
ok(plugin.includes('"UNAVAILABLE"') && plugin.includes('离线且无缓存'), '无缓存离线时明确 reject');
// JSON 200/304 are fenced inside the disk actor, for foreground fetch and background SWR.
ok(plugin.includes('beginJSONRequest(key: key)') && plugin.includes('self.revalidateJSON(request: request, url: url, entry: entry)'), 'JSON 请求在网络前取得 actor ownership，SWR 沿用该 token');
eq((plugin.match(/storeJSON\(\s*request: request,/g) ?? []).length, 2, '前台/后台 JSON 写入均携带 token');
eq((plugin.match(/disk\.revalidateJSON\(request: request\)/g) ?? []).length, 2, '前台/后台 304 均由 actor 校验');
ok(!plugin.includes('markRevalidated(') && !disk.includes('func storeJSON(key:'), 'JSON 插件无未保护写回/304 捷径');
ok(disk.includes('request.epoch == jsonEpoch') && disk.includes('jsonRequests[request.key] == request.id'), 'JSON epoch 与最新请求 UUID 双重校验');
ok(source['AnyunDiskCache.swift'].includes('CryptoKit') && source['AnyunDiskCache.swift'].includes('SHA256'), '缓存键是 SHA-256');
ok(source['AnyunDiskCache.swift'].includes('maxEntries') && source['AnyunDiskCache.swift'].includes('lastAccess'), 'LRU 淘汰按 lastAccess/maxEntries');
ok(source['AnyunDiskCache.swift'].includes('.atomic'), '索引原子写');
ok(/clear\(scope/.test(source['AnyunDiskCache.swift']), 'clear 支持 scope');

// —— 4b. AVPlayer 真正命中磁盘（2026-11-21 接通）——
// 缓存键永远是队列里的稳定 https 源地址；签名目标不落盘、不进日志、不进索引。
ok(playback.includes('AnyunCacheKey.hash(url.absoluteString)'), 'AVPlayer 命中键源自稳定源 URL');
ok(playback.includes('private static func isStableAudioAddress(') && playback.includes('url.query == nil') && playback.includes('url.fragment == nil'), '队列准入拒绝带查询串/签名的地址（#33）');
ok(playback.indexOf('Self.isStableAudioAddress(raw)') < playback.indexOf('AnyunCacheKey.hash(url.absoluteString)'), '准入先于缓存键推导：签名目标永不成为键（#33）');
ok(playback.includes('admitted = self.admit(typed)') && playback.includes('admissionDropped'), 'configure 逐条准入并上报丢弃数（#33）');
ok(playback.includes('localPlaybackURL(forKey: key)'), 'loadCurrent 优先本地完整文件');
ok(disk.includes('if !leasesSwept { releasePlaybackLeases(); leasesSwept = true }'), 'actor 首次命中前清扫残留租约（不与主线程文件 IO 竞态）');
ok(!playback.includes('expiresAt'), '签名目标/过期时间不在 NativePlayback 出现（不持久化）');
// 租约层：硬链接 + 正确扩展名（Ogg Opus）+ 数量有界 + 不把残片当命中。
ok(lease.includes('linkItem(') && disk.includes('static let playbackExtension = "ogg"'), '播放租约：硬链接 + .ogg 扩展名（Opus in Ogg）');
ok(lease.includes('fileExists(atPath: media.path)') && lease.includes('Darwin.rename(staged.path, link.path) == 0'), '先建硬链接再原子替换；失败保留当前租约，无完整 bin 不伪造命中');
ok(lease.includes('prefix(2)'), '租约数量有界（≤ 2，不无限副本）');
// 磁盘层：超限/取消/epoch 有界语义。
ok(disk.includes('AnyunDownloadOutcome') && disk.includes('case transient'), '单曲>容量：不落盘，transient 内存服务');
ok(disk.includes('skippedKeys.contains(key)') && disk.includes('AnyunCacheOversizeError.oversize'), '超限后不再反复下载');
ok(disk.includes('epoch += 1') && disk.includes('.task.cancel()'), 'clear 推进 epoch 并取消在途，不复活');
ok(disk.includes('releaseDataSlot') && disk.includes('releaseFileSlot'), '槽位由 worker 按 id 释放（旧任务不释放新槽）');
const sharedDataDownload = disk.slice(disk.indexOf('func downloadOnce('), disk.indexOf('private func commitData('));
ok(!/onCancel:[\s\S]{0,80}worker\.cancel/.test(sharedDataDownload), 'scheme 共享 data worker：订阅者取消不杀其他订阅（旧缺陷已修）');
ok(disk.includes('onCancel: { worker.cancel() }'), '当前曲 SWR 私有订阅取消会终止文件 worker');
ok(disk.includes('requireExisting: true') && handler.includes('revalidateMedia(key: key, original: entry, response: response)'), '后台 revalidate 不复活已清条目');
ok(disk.includes('actual == file.bytes') && disk.includes('incompleteFile'), '提交前校验真实字节数，残片不当完整');
ok(network.includes('func downloadFile(') && network.includes('expectedContentLength'), '流式下载有 Content-Length 预检');
ok(network.includes('bytes > maxBytes') && network.includes('withTaskCancellationHandler'), '流式下载超限中断 + Task 取消有界');
ok(playback.includes('.part")'), '预取临时文件路径存在且位于 incoming 隔离区');
ok(playback.includes('UUID().uuidString'), '预取临时路径按订阅唯一（旧 worker 收尾不撞新 worker）');
// 离线与恢复：未缓存时流式首播不退化；下载完成绝不替换当前 item。
ok(playback.includes('离线且未缓存，无法播放'), '离线 cache miss 有中文说明');
ok(handler.includes('case .transient'), 'scheme 未命中路径处理 transient 载荷');

// —— 5. 不留真实地址/凭据 ——
const urlish = [...all.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
const allowed = new Set(['https://github.com/ionic-team/capacitor-swift-pm.git']);
const suspicious = urlish.filter((u) => !allowed.has(u));
eq(suspicious.length, 0, `Swift 无写死的外部地址（发现 ${suspicious.join(', ') || '无'}）`);
ok(!/\b(sk-|Bearer |token\s*=)\w{8,}/i.test(all), 'Swift 无凭据形态字符串');

console.log(`ios-cache: ${checks} 项静态断言通过（未编译、未真机）`);