# iOS 原生音频缓存（AVPlayer + 有界磁盘 LRU）

> **本地实现及 Linux 静态检查完成；Swift 尚未编译，iPhone 尚未验证。**
> Linux 没有 swiftc/Xcode，不安装替代工具、不把源码断言当作编译或播放验收。
> 尤其 Ogg Opus 本地文件是否被目标 iOS/AVPlayer 接受，必须经 Xcode 与真机确认。

## 当前实际播放路径

原生队列保存的是**稳定 HTTPS 源地址**，不是自定义 scheme，也不是一次性签名地址。
所有原生缓存键 = 稳定源 URL 的 SHA-256；307 的签名目标仅存在于单次 URLSession/AVPlayer
传输，不进索引、队列、日志或 UserDefaults。

准入（#33）：`configure` 与冷启动恢复都只接受稳定地址——绝对 https、裸路径、无
query/fragment/userinfo。带签名或查询串的条目直接丢弃、索引/历史重映射并留一条
`admission-drop` 诊断，不恢复、不缓存，也不作为缓存键；剩余队列照常播放。

- loadCurrent 异步询问磁盘 actor：校验索引、实际长度、Ogg/Opus 页结构/CRC/结束页，
  命中后建立 playback/<key>.ogg **硬链接**，再把本地 URL 交给 AVPlayer。
- 未命中立即安装稳定 HTTPS AVPlayerItem，不等待全曲下载后才开始首播。
- 真正请求播放时，只为**当前曲**并行预取完整文件。流式播放本身与预取可能各有一次传输，
  这是首播即听与下次完整离线缓存的取舍；不预取整队列。
- 切曲取消旧订阅及旧文件下载；下一条文件下载须等旧 worker 完成取消/临时文件清理。
  不把已取消任务从统计字典立即移掉后偷偷留在后台继续下载。
- 下载完成不会重装当前 item、自动播放或覆盖后选的曲；下次选播/故障恢复才重新查磁盘。
- 断网缓存命中不发媒体请求，可 seek；断网未命中会显示未缓存/无法播放原因，不伪装命中。

AnyunCacheSchemeHandler 仍保留给旧 scheme 请求兼容（Range、SWR），**不是当前原生播放器路径**。
Web 浏览器自己的离线缓存见 web-offline-cache.md；不能拿浏览器临时媒体缓冲代替原生缓存。

## 文件与职责

| 文件 | 职责 |
|---|---|
| AnyunDiskCache.swift | actor：索引、LRU、文件提交、清除、租约生命周期、Ogg 完整性检查 |
| AnyunPlaybackCache.swift | MainActor 薄适配，异步调用 actor；硬链接辅助函数及 ≤2 租约纯规则 |
| AnyunCacheNetwork.swift | URLSession 流式预取、大小/完整响应校验、取消桥接、超时 |
| NativePlayback.swift | 稳定键、异步查本地、播放/预取编排、generation/暂停/seek/恢复 |
| AnyunCacheSchemeHandler.swift | 旧 scheme 的 Range 与条件刷新；刷新去重和旧条目写回防护 |
| AnyunCacheConstants.swift / AnyunCachePlugin.swift | 策略/桥接/JSON 缓存；JSON fetch/SWR 已接 actor 请求 ownership |
| ios/App/App.xcodeproj/project.pbxproj | 包括 AnyunPlaybackCache.swift 的 App target Sources 注册 |

## 完整性、容量与磁盘语义

目录：Caches/anyun-cache/，系统可清理，不承诺永久离线下载。

- <key>.bin + index.json：索引的 key 必须为 64 位小写十六进制，实际文件须为普通文件且长度
  与索引一致。孤儿 bin、失配长度、零字节、残片都不作为 native 命中。
- incoming/<key>-<UUID>.part：流式写文件，不整曲缓冲内存。只接受最终 HTTP **200**，
  拒绝 Content-Range/206；声明 Content-Length 超预算、累计字节超预算、实际字节数与声明
  不一致、磁盘写/close 失败、取消、空文件均失败并删除临时文件。
- 提交前再核磁盘实际长度，以及 Ogg capture/version、页序列/stream serial、OpusHead、
  页 CRC 和最后 EOS。无 Content-Length 的分块响应也必须完整收束 Ogg；校验内存为单页级别。
  此检查不是音频解码器，不宣称能证明 Opus 帧一定可播放。
- 成功文件才 move 到正式路径并入索引。index.json 通过 Foundation .atomic 替换。
- LRU 按 lastAccess，限制 maxBytes 与 maxEntries；native 命中也 touch。落盘/冷加载/统计与
  下载预算查询都会执行容量约束，缩小策略后再次统计即可淘汰。正在播放读的是租约而不是 bin。
- playback/<key>.ogg 是**硬链接**，不复制音频。链接失败就是 miss；绝不退化为符号链接
  或直接 bin（这两种都无法保证 clear 后继续 seek）。
- 当前及上一首最多 **2 个**受管租约；每次新命中修剪，首次 native lookup 清扫崩溃/上次
  进程残留，空队列释放全部。主线程不做任何缓存文件/索引读写。
- clear/LRU 只删 bin/索引，不掐断已获租约的当前 item。缓存面板 bytes/freedBytes 是
  **索引逻辑字节**，不等于 OS 立即回收字节：仍播放的硬链接、AVPlayer 打开 fd、incoming
  临时文件不计入；最坏还可能有 ≤2 个旧租约（各不超过当时单曲预算）。
- 单曲超过容量不落盘。超限记忆仅限最多128键，media/all clear 清空；瞬时网络错误不进
  永久黑名单。每次明确重选曲可再尝试一次预取，自动恢复/暂停继续不会产生下载风暴。

旧 scheme 的超容量完整响应仍使用 transient 内存切片兼容；它不是当前 AVPlayer 有界文件预取通路。

## 并发与清除边界

- 所有正式媒体路径、索引、建链/修剪均在同一 actor；避免原来 main 同步建链与 actor
  clear/LRU 之间的竞态，也避免建到未索引/已被淘汰的文件。
- 共享 data worker 的单个订阅者取消不杀其他订阅；取消订阅在 await 返回后抛取消。
  file worker 则由当前曲单槽编排，换曲/clear 会取消其 URLSession。
- 每个槽有 UUID，只有当前槽的 worker 能提交/释放；clear 移除所选 data 槽并推进 epoch，
  mediaEpoch 还使旧 lookup 之后才排到的预取请求失效。旧文件 worker 即使不听取消也不能提交。
- media-only clear 不误杀 JSON worker；json-only clear 不使当前媒体 worker 的结果无故作废。
- scheme revalidate 按 key 去重，并核对原条目的内容确认时间/bytes/etag；clear 后重建的新
  条目不会被旧响应覆盖；requireExisting 也防止丢失条目被刷新复活。
- JSON fetch/SWR 在网络前从 actor 取得同 key 最新请求 UUID、独立 jsonEpoch，以及同一
  actor turn 内的 entry/bytes 快照；SWR 沿用该 ownership，不在迟到响应时重新申请。
  JSON/all clear 推进 jsonEpoch 并撤销 ownership；media-only/未知 scope 不影响 JSON。
- JSON 200 store 与 304 确认均在 actor 内同步校验 epoch + UUID 后才提交，中间没有 await。
  clear 后旧响应不能复活；被更新、invalidate 或 LRU 淘汰的条目也撤销 ownership，旧 304
  不能给后来相同 key/bytes/etag 的新条目刷新 age。304 只返回自己请求时的快照，不混读新 entry。
- 同 key 采用**最新开始（actor 发 token 顺序）的请求可写**，不是最后完成者胜出；新请求失败
  也不会恢复旧请求的写权限。不同 key 独立；旧请求结束只释放自己的 UUID，不会误清新槽。
  clear 不取消 JSON 网络本身：迟到 200 仍可返回给原调用者，但不落盘；失败回退仅使用此前
  已捕获的内存快照（clear 不撤回已发给调用者的数据），不复活磁盘条目。

## 播放状态与恢复

- 每次 load 递增 generation、取消旧 lookup/预取订阅；异步结果必须 generation 及取消检查
  后才能 attach。等待磁盘期间的 play、pause、sleep 到点、seek 以**最新 intent/位置**为准。
- 预取完成不改播放 intent；切曲后的旧成功/失败不能给后来曲写错误或失败标记。
- 锁屏歌词、原生睡眠时钟、音频激活 token、冻结恢复位置/已知时长、队列持久化沿用原路径。
- 长暂停后签名失效/流失败，恢复重建稳定源 HTTPS item，重新走307；本地已完整缓存则可命中。
- 本地 item failed/卡死后本次选择绕过并移除坏 bin，尝试联网流式；不会重复挂住同一坏文件。
  看门狗最多8次恢复，仍失败则停止 loading、保留可读错误，可重新选曲/播放重试；
  immediate failed 也交看门狗，不在 attach/start 内形成无界递归。

## 桥接契约（未变）

- 插件 jsName AnyunCache，identifier AnyunCachePlugin。
- configure({policy?}) / setPolicy({policy}) → {policy}
- stats() → {bytes, entries, mediaEntries, jsonEntries, maxBytes, cacheDir}
- clear({scope: all|media|json}) → {freedBytes, entries}
- fetchJSON({url,force?}) → {data,source: cache|network|stale,ageSeconds,offline}
- 无 JSON 缓存且网络失败：UNAVAILABLE / 离线且无缓存。

策略持久化键 anyun.cache.policy.v1。默认与夹取范围：

| 字段 | 默认 | 范围 |
|---|---:|---:|
| maxBytes | 536870912 | 16777216…4294967296 |
| maxEntries | 4000 | 64…20000 |
| mediaRevalidateSeconds | 604800 | 3600…2592000 |
| jsonStaleSeconds | 60 | 5…3600 |

## 本地检查与 macOS 命令

Linux 可运行（只证明 JS/TS 行为或源码接线，不证明 Swift 编译）：

~~~sh
npm run test:ios-cache
npm run test:native-audio
npm run test:native-cache
node scripts/test-native-offline.mjs
~~~

native-offline runner 会明确打印 Swift SKIP，不把它算作行为测试通过。macOS 编译并运行
**真实磁盘 actor 行为测试**（合成 Ogg 页、临时目录、注入 operation，无网络/真实音频）：

~~~sh
node scripts/test-native-offline.mjs --require-swift
~~~

等价手工命令（在仓库根，macOS 12+ SDK，Swift5语言模式与当前工程一致）：

~~~sh
swiftc -swift-version 5 -strict-concurrency=minimal -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" \
  ios/App/App/AnyunCacheConstants.swift \
  ios/App/App/AnyunCacheNetwork.swift \
  ios/App/App/AnyunDiskCache.swift \
  ios/App/App/AnyunPlaybackCache.swift \
  ios/App/App/AnyunCacheSchemeHandler.swift \
  scripts/test-native-cache.swift \
  -o /tmp/anyun-native-cache-test && /tmp/anyun-native-cache-test
~~~

测试输入已含所有自定义类型（尤其 AnyunDownloadedFile 与 AnyunPlaybackLookup），修正了
await 循环语法、String→Data fixture、租约目录建立和最近两项顺序断言。覆盖容量/条目数、
共享下载取消、清除 epoch、跨曲单槽排队、迟到临时文件清理、坏格式/CRC、真实硬链接 inode、
clear后租约可读、租约上限和旧revalidate不能覆盖新条目。新增真实 JSON actor 测试覆盖冷 fetch/
暖 SWR 的 json/all clear 迟到 200/304、clear 后重建 ABA、最新开始请求胜出与旧收尾、
media-only scope、相同内容重写、invalidate/LRU 及独立 key。**这些 Swift 测试尚未执行。**

## 必须完成的外部验收（尚未执行）

1. macOS runner 编译/执行；随后 Xcode App target 编译（含 Capacitor/AVFoundation 并发诊断）。
2. 真机首播未缓存曲立即流式，同时预取最终入库；重选该曲、断网、seek均正常。
3. 缓存命中时 clear/LRU：当首继续播放/拖动；下次选择不再命中；确认面板逻辑与实际磁盘差异。
4. 高速切A→B→C、下载中clear、下载刚完成clear、lookup中pause/seek/sleep：不得复活缓存、
   播回旧曲、自动继续或失去用户暂停intent；抓统计确认仅当前曲一个文件预取worker。
5. 飞行模式冷启动有缓存可播；无缓存明确报错且有限重试后不无限转圈。
6. 长暂停超过签名TTL后恢复，旧签名403/网络故障/冻结后，稳定源重新307并保持位置、时长。
7. 本地坏Ogg/有效容器但不可解码内容/目标iOS不支持：剔除本地并流式回退，有限失败可重试。
8. 锁屏歌词、耳机控制、睡眠渐弱/到点停止、后台切曲与前台状态对账回归。
9. App杀进程/崩溃残留、系统清理bin、索引损坏/长度失配，均不假命中、租约不无限增长。
10. JSON fetch/SWR 中 json/all clear 后迟到 200/304 不复活、不刷新新 entry age；并发最新开始请求
    胜出、media-only clear 不影响 JSON。App离线目录冷启动仍以catalog实现自身验收为准。
