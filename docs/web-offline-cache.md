# 网页音频离线缓存（Web Offline Cache）

状态：已实现（`feat/public-v2`，未发布）。原生 App 侧另有 AVPlayer 磁盘缓存接入，见 [ios-audio-cache.md](ios-audio-cache.md)；本文只覆盖浏览器网页。

## 目标与边界

- 用户在线上播放某曲时，网页在**后台完整下载一次**；完成即宣布「本曲可离线」。之后离线重开网站、重播该曲直接本地播放，不依赖网络。
- **只缓存当前播放的曲目**（用户已选择播放），不做全库预抓。
- 不引入新依赖、不改服务端音频代理/数据拓扑、不改变 `attachAudioRenewal(a, identity, fail)` 的调用方契约。
- App（Capacitor）内一律不走这层：队列保留稳定 HTTPS，由 AVPlayer 独立读取原生磁盘缓存。

## 组成

| 文件 | 职责 |
|---|---|
| `src/lib/web-audio-cache.ts` | 音频字节缓存唯一所有者：CacheStorage（`anyun-web-audio-v1`）+ Blob URL + LRU + 事件通道。零依赖、可 node 直测。 |
| `src/lib/audio-renewal.ts` | 播放换源时接缓存：命中→Blob（零在线请求）；未命中→原 resolve 流程，成功后后台发起下载。 |
| `src/service-worker.ts` | 应用 shell：构建 JS/CSS（含动态 chunk）预缓存 + 导航快照离线 fallback。**从不拦截** `/api/**`、`/brand/**`、`/audio/**`。 |
| `src/routes/+layout.svelte` | SW 显式注册点：仅 web（非 Capacitor、非 dev、`isSecureContext`）。SvelteKit 默认会因 `src/service-worker.ts` 存在而自动注册（`kit.serviceWorker.register` 缺省 true，会绕过环境判定），因此需配合 `svelte.config.js` 设 `kit.serviceWorker.register=false`，layout 成为唯一注册入口。 |
| `src/lib/components/WebCacheSheet.svelte` | 用量/上限/清除/本曲离线状态面板（Sheet 组件，与原生 CacheSheet 同款交互）。 |
| `scripts/test-web-offline.mjs` | 行为回归（假 CacheStorage/假 fetch，模拟真实语义）。 |
| `scripts/test-web-offline-browser.mjs` | 真浏览器端到端（需外部注入 PLAYWRIGHT_MODULE/CHROMIUM_PATH，未配置时明确 SKIP，不算通过）。 |

## 关键语义

### 1. 只认「完整 200」

沿用 Workbox 官方结论（`cacheable-response` / caching-streamed-responses）：**流式/分片响应不能当已缓存**。本实现：

- 不带 Range 的 `fetch`，仅 `status===200` 且非 `opaque`/`error` 响应可入库；206 一律拒收（网页续签/播放的分片请求绝不污染缓存）。
- 校验 Content-Type（`audio/*`、`video/*`、`application/ogg|mp4|x-wav|octet-stream`；HTML/JSON 错误页拒收）、非零 body、`Content-Length` 与实收字节一致。
- 跨域直连音频以 CORS 模式取；**CORS 失败=下载失败=不缓存**，在线播放路径完全不受影响（诚实降级）。
- 缓存写入用自构 `Response`（只带 `content-type` 与两个 `x-anyun-*` 元数据头），浏览器 HTTP 缓存语义不参与判定。
- 完整条目不可变：命中路径不发任何重验证请求，失败/206/截断响应永远不会替换已完整入库的条目；
  读路径带每 key 代次校验，慢读拿到的旧字节在期间发生写入/失效/清除时一律丢弃（不覆盖新状态、不复活已清条目）。
- 实测坑（Chrome for Testing 157）：缓存条目的 `matchAll()` 响应 `response.url` 为空串，真实 key 只在 `keys()`（Request.url）里；索引装载按 `keys()`/`matchAll()` 插入序配对，长度不齐时退回 `response.url`。

### 2. 稳定 key，签名零残留

- 持久 key = 剥离 query/hash 后的稳定 URL：同源必须匹配严格路由 `/api/audio/<64hex>.opus`；跨域只接受无凭证、路径带音频扩展名的绝对 http(s) URL。`username/password` 拒绝。
- `?resolve=1` 返回的签名地址、`X-Amz-*` 等一次性参数**永不**进入缓存 key、条目元数据或 localStorage（LRU 索引只存稳定 key）。回归测试对 `localStorage` 全量落盘内容做过泄露扫描。

### 3. 播放路径（audio-renewal 接线）

```
play → renew
  ├─ 已知命中（Blob 注册表/已装索引）→ 直接 Blob URL 换源，零在线请求     ← 离线重开走这条
  ├─ 未知 → 并行：立即发 ?resolve=1（12s 超时/abort 有界）+ 异步查缓存
  │     ├─ 缓存命中 → 中止未用的 resolve 请求 → Blob 换源
  │     └─ 未命中 → 用 resolve 结果在线播（与从前完全一致），随后
  │           后台 prepareWebAudio(稳定key)（signal 绑当前 epoch：换曲即取消）
  └─ 换曲/停止 → a.load() 覆写释放旧 Blob handle（1.5s 宽限 revoke，
        正在播放的地址绝不撤销；切曲释放是秒级的）
```

- Blob 源播放中 `error` → 作废该缓存条目（`invalidateCachedAudio`）→ 自动落回在线 resolve；缓存损坏会自愈（恢复播放后重新下载）。
- 原有语义不变：renewal/expiresAt、暂停位置保持、pause intent、`NotAllowedError` 不起重试、resolve 失败两次封顶、「下一次播放重置」。`inspect()` 增加 `fromCache` 诊断字段。
- 恢复会话（`initSession` 预载）仍先挂在稳定地址上；离线时该预载失败是良性的——用户点播放即命中 Blob。

### 4. 有界与安全阀

- 默认上限 **512MB，与 App 一致**；可 1MB–4GB 夹取，`localStorage` 持久。
- 单曲上限 100MB（防御性）；同时最多 2 条后台下载；同 key 并发/重复调用去重（至多一条在途）。
- LRU 真实有界：每次写入后按最久未访问逐出；`QuotaExceededError` → 逐出重试（≤8 次），仍失败则**诚实放弃缓存**，播放无恙。
- `clearWebAudioCache()`：清 token 自增 → 在途下载中止、迟到的 body 不得回写（防「清理后复活」）；已发出的在播 Blob handle 不受影响，release 后才回收。
- CacheStorage 不可用（非安全上下文、旧浏览器、隐私限制）：全部 API 返回「按原 URL 播放」的降级对象，从不抛致命错误。

### 5. Service Worker（离线重开应用）

- `install` 预缓存 `$service-worker` 的 `build` 全集（含动态 import 的 JS/CSS chunk）+ `static` 中的图标/图片类文件；显式排除 `audio/`、`brand/`、`*.json`、`*.html`（不把真实音频/品牌数据带进 precache）。
- 导航请求网络优先，成功即存快照（上限 8 条，`anyun-nav-<version>`）；离线时用「本页快照 → 最近首页 → 503 提示」兜底，让重开能进应用并用 Blob 缓存播已存曲目。
- 缓存命名空间 `anyun-shell-<version>`/`anyun-nav-<version>`；activate 只删自己旧版本，**绝不触碰音频缓存**。
- 首次安装主动保存首页；更新不调用 skipWaiting，让旧页面保留自己的资源版本，关闭旧页面后再激活新版本，不强制 reload。

### 6. UI

- Web 分支入口（`showCacheEntry`，已接线）：原生壳用 `CacheSheet`，网页用 `WebCacheSheet`；两者都真实存在，无假入口。
- `WebCacheSheet`：用量条、上限、清音频、本曲状态（可离线/下载中/未缓存）、「本曲已完整缓存可离线」事件提示、浏览器可能回收/隐身模式/仅完整缓存可离线/离线重开依赖页面版本等说明与不支持提示。

## 不做的事

- 不缓存真实音频进 Service Worker 路径；不用 206/opaque 冒充完整缓存；不付费服务、不加依赖。
- 不改 `/api/audio` 服务端（代理/签名/数据拓扑零改动）；网页音频模块不负责 Swift/native-cache/player 状态机；共享页面与测试入口已集成。
- 不自动预抓整队列——只缓存用户点播过的当前曲。

## 已知限制

- 后台下载是在线播放（元素自己拉流）之外的一份完整字节，同 key 去重且每曲一次；local 后端响应带 `immutable`，多数浏览器会命中 HTTP 缓存合并流量，但规范上不保证。
- 首次冷索引 + 离线首播的极端竞态下，resolve 请求会发出后被中止（不消费）；索引预热后完全零请求。
- Safari 对 CacheStorage 总量有独立配额（约存储的少量比例），被系统整仓清掉时缓存层静默降级为在线播放。
- iOS Safari 的 Blob URL `<audio>` 后台连续播放依赖现有 Media Session/睡眠链路，未做真机验收。

## 验证

```bash
node scripts/test-web-offline.mjs            # 行为回归（124 项断言）：模拟 CacheStorage，非字符串断言；vite-node 下同样可跑
node scripts/test-audio-renewal.mjs          # 原续签回归（未改动，node 直跑）
vite-node scripts/test-audio-renewal.mjs     # test:catalog 内的原样跑法
PLAYWRIGHT_MODULE=~/.nvm/.../playwright-core/index.mjs CHROMIUM_PATH=~/.local/opt/chrome-linux64/chrome \
node scripts/test-web-offline-browser.mjs    # 真浏览器端到端（无 env 时明确 SKIP，不算通过）
```

2026-11-21 实跑记录：真实 headless Chrome（Chrome for Testing 157，自起 127.0.0.1 合成服务器 + 合成 WAV，零真实数据）全绿：完整 200 入库→Blob 命中→`<audio>` 真实解码播放推进；reload 冷内存 + 断网后离线播放/拖动正常、未缓存曲目诚实失败；206 未入库；持久 key 无签名；真 CacheStorage 下 LRU 有界（1MB 上限、18×64KB→16 存活 1,024,704B）；clear 后真实存储归零。生产 Node 构建另经 scripts/test-offline-app-browser.mjs 实测：首次打开后关闭页面，断网新开标签，恢复 SW 页面、目录快照及队列，Blob 源解码播放成功。未做：iPhone Safari、Vercel 生产验收。
