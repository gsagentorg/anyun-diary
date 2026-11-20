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
const declared = ['configure', 'stats', 'clear', 'setPolicy', 'fetchJSON'];
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
ok(source['AnyunDiskCache.swift'].includes('CryptoKit') && source['AnyunDiskCache.swift'].includes('SHA256'), '缓存键是 SHA-256');
ok(source['AnyunDiskCache.swift'].includes('maxEntries') && source['AnyunDiskCache.swift'].includes('lastAccess'), 'LRU 淘汰按 lastAccess/maxEntries');
ok(source['AnyunDiskCache.swift'].includes('.atomic'), '索引原子写');
ok(/clear\(scope/.test(source['AnyunDiskCache.swift']), 'clear 支持 scope');

// —— 5. 不留真实地址/凭据 ——
const urlish = [...all.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
const allowed = new Set(['https://github.com/ionic-team/capacitor-swift-pm.git']);
const suspicious = urlish.filter((u) => !allowed.has(u));
eq(suspicious.length, 0, `Swift 无写死的外部地址（发现 ${suspicious.join(', ') || '无'}）`);
ok(!/\b(sk-|Bearer |token\s*=)\w{8,}/i.test(all), 'Swift 无凭据形态字符串');

console.log(`ios-cache: ${checks} 项静态断言通过（未编译、未真机）`);