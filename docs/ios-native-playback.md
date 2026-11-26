# iOS 原生播放方案

目标：网页保留时间线、搜索、选播和歌词；原生拥有播放引擎及后台生命周期。原生播放、队列、系统媒体控制及睡眠定时已接入现有网页 UI；真机验收见 ios-opus-test.md。后续仍需覆盖网络恢复与长暂停后恢复；签名链接由稳定端点逐传输重定向，原生不另做续签（见文末「签名链接续签决策」）。

## 当前缺口

`player.svelte.ts` 使用 HTMLAudioElement，队列切换、随机历史、睡眠停止与渐弱均在 JS 中执行。Info.plist 尚未声明后台音频。仅配置音频会话不足以让网页定时器和切歌逻辑在后台可靠工作。

## 职责与接口

- Swift 播放服务持有 AVPlayer/AVQueuePlayer、队列、当前索引、随机历史、倍速、睡眠截止时间及渐弱曲线。锁屏后独立完成下一首、上一首及停止。
- Capacitor 自定义插件提供 setQueue、play、pause、seek、skip、setRate、setSleep、getSnapshot；每条曲目包含稳定 ID、音频地址、标题、场次及已知时长。队列编辑使用版本号，快速选播使用请求编号，防止旧异步回调覆盖新选择。
- 网页选播提交队列与起始项；播放器 UI 订阅原生状态（曲目 ID、队列版本、进度、时长、播放/缓冲/失败状态、随机历史）。原生是状态来源，网页不同时创建 audio 或 Web Audio 图。
- 回前台/页面重载重新获取快照，不把网页中的过期状态反向覆盖原生；Web 版本保留现有引擎。
- 播放服务配置 AVAudioSession playback 和后台 audio，接入 MPNowPlayingInfoCenter、MPRemoteCommandCenter，处理来电中断、恢复授权、耳机断开暂停及蓝牙路由变化。
- 原生持久化队列与进度；进程被终止后提供恢复入口，不承诺自动继续播放。队列里只存稳定 HTTPS 端点，签名的临时目标只存在于单次传输：原生既不持久化它，也不需要在网页暂停后代为刷新。

## 签名链接续签决策（#39）

文档此前声称「原生层会刷新签名链接」，实现从未如此，也不需要如此。判断是否需要真正实现原生续签，只看三条：

1. 稳定端点是否无法对**每个**请求（含 Range、续传、重新建流）可靠 307？
2. 播放器是否会在暂停/后台/恢复后，**跨链接有效期复用某个已解析的临时目标**？
3. 是否存在**只能下发直连临时链接**的部署？

当前证据三条均不成立：

- 发布器只存 `opus: audio/<hash>.opus`，web/session/native 队列一律用稳定端点（`/api/audio/<hash>.opus` 或所选 backend 的同源绝对路径），不固化签名 URL。
- `NativePlayback.swift` 只把稳定地址交给 AVPlayer；缓存键 = 稳定 URL 的 SHA-256；签名目标不出现于队列、UserDefaults、日志或缓存键（源码契约见 `scripts/test-native-audio.mjs`、`scripts/test-ios-cache.mjs`）。
- 每次独立传输都由端点现场签发 307，Range/续传同样跟随重定向；`expiresAt` 从不进入原生状态。

因此维持「隐式逐传输续签」，并在 `docs/data-publication.md` 的「续签与兼容边界」中如实描述。**不实现**原生定时重解析。若将来出现反证（例如真机上 307 不能覆盖 Range/续传，或某部署只给临时直链），再改为「原生持久化稳定端点 + 到期前重解析并保位」的方案。

验收所需的真机检查（Linux 无法覆盖）：长暂停超过 `AUDIO_URL_TTL_SECONDS`（默认 900s）后恢复仍能续上；后台播放中被系统回收后回前台重建 item；Range 拖动与断点续传在 307 下仍为 206；过期后 seek 只触发一次重新解析/重定向。

## 实施顺序

1. 先在真机用现有远程 Ogg Opus 文件验证 AVPlayer 的加载、拖动与后台播放，不能以 WebKit 已能播放推断 AVFoundation 兼容。必要时生成原生可用的 AAC/M4A 副本并明确 URL 映射，不能只改扩展名。
2. 实现单曲桥接、状态同步、后台音频与系统控制，验证锁屏及切换 App。
3. 将完整队列、随机/去重/历史、自动切歌与队列编辑迁入原生，覆盖后台连续跨曲。
4. 实现原生睡眠截止时间和渐弱、进度持久化、断网失败与恢复；随后优化安全区、原生播放面板与手势。

## 验收

真机连续锁屏跨至少三首；锁屏和耳机控制可暂停、恢复、前后切歌、定位；后台睡眠到期停止且渐弱正确；来电与拔耳机行为正确；回前台曲目、队列、歌词和进度一致；快速换歌无叠播；断网失败可见且可恢复；页面重载不抢回旧进度；Web 现有播放测试继续通过。

参考：[Apple 后台媒体配置](https://developer.apple.com/documentation/avfoundation/configuring-your-app-for-media-playback)、[音频会话 playback](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback)。
