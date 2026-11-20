# iOS 原生音频缓存（SWR + LRU）

> 状态：**实现完成，未编译、未真机验证**（本机 Linux 无 `swiftc`/Xcode）。Swift 源码按 Capacitor 8.6.0 iOS 源码
> （`node_modules/@capacitor/ios`）与本仓库 `ios/App` 现有结构编写；JS 侧桥接与缓存策略纯函数有自动化测试，
> Swift 侧只做**静态契约断言**（见 `scripts/test-ios-cache.mjs`）。真机验收清单见文末。

目标：音频与索引在原生层缓存，网页层不实现缓存逻辑，也不感知缓存实现。

## 分层

```
WKWebView (<audio src="anyun-cache://media?u=...">)      ← web 只做一次 URL 适配（native-cache.ts）
        │  WKURLSchemeHandler
        ▼
AnyunCacheSchemeHandler  ──────────────┐
        │                              │
        ▼                              ▼
AnyunDiskCache (actor, LRU)      URLSession（直连后端）
        │
        ▼
Caches/anyun-cache/<sha256>.bin + index.json
```

`/api/catalog`（release 清单）与 `/api/month/<id>`（月块）这类 JSON 不走 scheme：网页侧 `fetch` 在 App 里
被 `CapacitorHttp` 接管，无法拦截；因此它们改由插件方法 `fetchJSON` 走同一套磁盘缓存（SWR，但 revalidate 更激进）。
`/api/current`（版本指针）与 `/api/search` 仍走普通 fetch：前者必须每次现查，后者是流式响应。
新架构下月块与 release 内容不可变，缓存命中即整块可用；离线冷启动只要能拿到清单与已缓存月块就能列表+播放。

## 实现文件

| 文件 | 职责 |
|---|---|
| `ios/App/App/AnyunCacheConstants.swift` | 契约字面量、策略结构（默认值/夹取/持久化）、错误类型 |
| `ios/App/App/AnyunDiskCache.swift` | actor 磁盘缓存：SHA-256 键、`index.json` 原子写、LRU、同 key 并发合并 |
| `ios/App/App/AnyunCacheNetwork.swift` | URLSession 薄封装：Range 透传、条件请求、10 s 超时、禁用系统缓存 |
| `ios/App/App/AnyunCacheSchemeHandler.swift` | `WKURLSchemeHandler`：命中即回（206 Range）、后台 revalidate、失败不删缓存 |
| `ios/App/App/AnyunCachePlugin.swift` | 插件 `AnyunCache`：`configure/setPolicy/stats/clear/fetchJSON` |
| `ios/App/App/AnyunBridgeViewController.swift` | 注册 scheme handler（强引用）与插件 |
| `src/lib/native-cache.ts` | 网页侧适配：scheme URL 构造/解析、策略夹取、桥调用、失败文案 |
| `src/lib/components/CacheSheet.svelte` | App 内「本地缓存」面板：占用/上限/清除（入口只在原生壳内出现） |
| `scripts/test-ios-cache.mjs` | Swift ⇄ TS 常量、pbxproj 接线、语义痕迹的静态断言 |

## 契约（Swift ⇄ JS 必须一致）

| 项 | 值 |
|---|---|
| scheme | `anyun-cache` |
| media URL | `anyun-cache://media?u=<percent-encoded 原始 https URL>` |
| plugin jsName | `AnyunCache` |
| plugin identifier | `AnyunCachePlugin` |
| 方法 | `configure` `stats` `clear` `setPolicy` `fetchJSON` |

### 策略默认值与夹取范围

| 字段 | 默认 | 含义 | 夹取 |
|---|---|---|---|
| `maxBytes` | 536870912（512 MiB） | 缓存总量上限 | 16777216 … 4294967296 |
| `maxEntries` | 4000 | 条目数上限 | 64 … 20000 |
| `mediaRevalidateSeconds` | 604800（7 天） | 音频不可变 ⇒ 宽松 revalidate | 3600 … 2592000 |
| `jsonStaleSeconds` | 60 | 索引 60 秒内直接命中 | 5 … 3600 |

策略持久化在 `UserDefaults` 键 `anyun.cache.policy.v1`（JSON）。

### 方法返回

- `configure({ policy? }) → { policy }`：幂等；带 policy 等于 setPolicy。
- `setPolicy({ policy }) → { policy }`：夹取后落盘。
- `stats() → { bytes, entries, mediaEntries, jsonEntries, maxBytes, cacheDir }`
- `clear({ scope }) → { freedBytes, entries }`，`scope ∈ all | media | json`（缺省 `all`）
- `fetchJSON({ url, force? }) → { data, source, ageSeconds, offline }`，`source ∈ cache | network | stale`

## SWR 语义

### 音频（不可变）

- 命中且 `age ≤ mediaRevalidateSeconds`：立即完整/分段返回，不发网络请求。
- 命中且超过 revalidate 窗口：**先返回缓存**（视觉与在线播放一致），后台条件请求
  （`If-None-Match`/`If-Modified-Since`）刷新；304 只更新 age，200 覆盖内容，任何失败都保留缓存。
- 未命中：`URLSession` 拉取，成功（200）后整体写盘再服务；失败（离线）→ `didFailWithError`，
  绝不删除已有缓存、绝不把旧条目当失效。

### 索引（可变）

- 命中且 `age ≤ jsonStaleSeconds`：立即返回 `source:"cache"`，后台静默 revalidate。
- 命中但过窗：先尝试网络（10 s 超时，条件请求）；成功 `source:"network"`，失败且本地有缓存
  → `source:"stale", offline:true` + 旧数据，**不失效**。
- 未命中且网络失败：reject，message 里给可读原因（`UNAVAILABLE: 离线且无缓存`），UI 明确显示不可用，
  不显示假加载态。

## 存储与淘汰

- 目录：`Caches/anyun-cache/`（系统可清理，符合"缓存"语义）。
- 键：原始 URL 的 SHA-256；文件 `<hash>.bin`，元数据集中在 `index.json`：
  `{ key, kind: "media"|"json", bytes, createdAt, lastAccess, etag?, lastModified?, contentType? }`。
- 命中/写入都会 touch `lastAccess`；写盘后按 `maxBytes`/`maxEntries` 从最久未用开始淘汰
  （跳过正在服务的条目）；`index.json` 原子写（临时文件 + `replaceItemAt`）。
- 并发：单 actor 串行化；同 key 的并发请求合并（第一个负责下载，其余等待）。

## 网页层职责（只做适配，不做缓存）

`src/lib/native-cache.ts`：

- `nativeAudioSrc(url)`：原生且插件可用 → `anyun-cache://media?u=...`；否则原样返回（web 行为不变）。
- `nativeFetchJSON(url)`：原生走插件，web 回退 `fetch`。
- `nativeCacheStats()` / `clearNativeCache()` / `setNativeCachePolicy()`：设置/调试入口用。
- 纯函数 `buildCacheAudioURL` / `parseCacheAudioURL` / `clampCachePolicy` / `isCacheAudioURL` 可测。

## 真机验收清单（未执行）

1. 首次在线播放某曲：`stats()` 条目 +1；再次播放（断网）仍能播且 UI 无差别。
2. 飞行模式冷启动：有缓存的曲目正常播放；无缓存曲目显示"离线且未缓存，无法播放"，无无限转圈。
3. 目录 JSON（`/api/catalog` 与已浏览过的月块）：60 秒内重开立即出列表；断网重开仍出已有月块；未缓存的月块给出明确失败提示而不是空列表。
4. 设置/调试入口"清除音频缓存"后 `stats()` 归零，之后播放重新下载。
5. 连续播放至超过 `maxBytes`：老条目被淘汰，当前播放不中断。
6. 缓存跨进程重启保留；App 升级后仍可用。
7. 拖动睡眠音量条（见 `docs/sleep-timer.md`）在播放中稳定可用。