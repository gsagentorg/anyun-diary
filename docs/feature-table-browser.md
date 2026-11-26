# 功能清单：真实生产 UI 浏览器验收

## 运行

先提供本机现有 Chromium 和 Playwright ESM 模块路径，不安装依赖、不改 package：

```sh
CHROMIUM_PATH=YOUR-CHROMIUM-PATH-HERE \
PLAYWRIGHT_MODULE=YOUR-PLAYWRIGHT-MODULE-HERE \
node scripts/test-feature-table-browser.mjs
```

脚本要求已有 adapter-node 生产构建 `build/handler.js`；缺环境、缺构建、断言失败都返回非零，不跳过。构建由父会话统一安排，避免与并发 worker 的应用修改交叉构建。测试不启动 Vite，不连接 dev 或生产服务。

每个用例输出一条 JSON，最终汇总 passed/failed。任何失败均继续收集其余独立用例，最后 exit 1；没有 skip、自动重试或吞断言。

## 隔离与真实程度

- 两个随机端口、仅绑定 loopback 的 HTTP 源：应用源执行真实生产 Node handler（SSR、打包 JS/CSS），图片源只返回内存合成 PNG，无 ACAO。
- 应用源仅覆盖合成 current/manifest/month/audio JSON 与音频；其它 API 不进入真实存储 handler。两首 Alpha/Beta，120 秒 8kHz 正弦 WAV，只合成内容、不读目录及真实音频。音频路径沿应用 hash/.opus 约定，响应类型为 audio/wav，避免对本机转码器的依赖；此项不是 Opus 解码验收。
- 浏览器请求仅允许上述两源，外部请求全部 abort；环境输入只用浏览器/模块路径，品牌基址由临时第二源自动注入 dynamic public env，不含服务配置或凭据。
- 本套禁用 Service Worker，保证所有请求受同一网络 allowlist 约束。刷新后的 JS 在联网加载完成后再断网，因此本套的离线断言是完整音频 CacheStorage/Blob 和网络恢复，不冒充“断网冷开整个 shell”。完整 shell+目录冷启动另由现有 `scripts/test-offline-app-browser.mjs` 覆盖。
- 操作经真实按钮和 Playwright 鼠标。读取 `window.__anyunAudio` 仅用于观察，不调用播放器内部方法。sleep pointerdown/move/up 由浏览器产生，仅 pointercancel 注入 DOM 事件；只代表 Chromium，不代表 Safari/iPhone/WKWebView。
- context、browser、两台 server 在 finally 清理；不新增运行数据文件，不写应用、其它测试或配置。

## 覆盖矩阵

| 用例 | 断言 |
| --- | --- |
| 三态模式 | 缺省顺序→随机→单曲循环→顺序→随机，逐次点真实模式控件 |
| 清空 | 主控制区无清空；仅开队列仍无；队列操作次级菜单才出现；点后 audio paused、进度 0、队列行 0、播放器关闭、持久会话清除 |
| 运行睡眠 | 15 分钟运行中，在竖线距圆点超过 10 SVG 单位的位置拖；50% 中点；末端最多 93%/剩余 01:00；pointercancel 后移动不回弹、不继续拖 |
| 刷新/重载 | 观察真实 current API 请求；刷新保持 audio 源/播放时间推进/队列内容/document 标记且 0 导航；重载先二次确认，取消 0 导航；明确确认后恰好 1 导航且 document 标记消失 |
| 暂停恢复预取 | 离线暂停后恢复联网：计划下一首（第二行）静默完整入缓存；audio 仍 paused、src 不变、播放头不前进、无 alert 横幅（issue #7） |
| 断网与恢复 | Alpha 完整缓存、Beta 不存在；离线刷新不得触达服务器；重载冷内存后断网 Alpha Blob 真实播放推进；Beta 诚实报错且不伪造缓存；恢复联网真实 online 事件发 current 请求并可重试播放 |
| 跨源品牌 | 第二 loopback 源 PNG decode 成功/naturalWidth>0；源不同；无 ACAO；img 无 crossorigin |
| 热力日期域 | fixture 最后录音在五天前；最新日期列等于上海今天且今天 24 个无数据格 disabled。现有 UI 日期倒序，检查 chronological upper bound，非错误地把最右列当今天 |
| 逐曲视觉标识 | 离线队列两行分别 data-offline-availability=cached/missing；cached 不误报缺失，missing 显示“未完整缓存 · 联网后可重试”并应用 offline-missing 样式。此为并发实现的严格挂接点，不跳过 |

## 本轮实测（2026-11-21）

使用任务指定的现有生产 build（handler mtime 为本日 15:30:32，未重新构建；任务起点 HEAD=8a1ec14，期间他人提交到 5aaae3c，不能将工作树新改动视作已进入该 build）。最终本子代理运行结果：**7 PASS / 1 FAIL，exit 1**，externalRequestsBlocked=0，serverErrors=[]。

已通过证据：

- 模式顺序全部符合；清空后 paused=true、time=0、队列清零。
- 睡眠 midway=50、clamped=93、remainingText=“进行中：柔和渐隐 · 剩余 01:00”、afterCancel=93。
- 刷新保留 2 项队列/持续播放；取消重载=0 次，确认重载=1 次。
- 离线 Alpha 的 Blob 播放 currentTime=0.216252；Beta 未完整缓存不能离线播；online 事件恢复和重试播放成功。
- PNG 跨源解码成功，ACAO=false、crossorigin=false。
- 热力日期上界=上海今天，今天 24 空格；最后录音早五天。

唯一 FAIL（保留原始错误核心）：

```text
per-track-visual-cache-indicators
locator.waitFor: Timeout 8000ms exceeded.
waiting for getByRole('dialog', { name: '播放队列', exact: true })
  .locator('[data-offline-availability="cached"]') to be visible
```

归因：当前 build 未含并发 worker 正新增的逐曲标识；已读取其源码实际属性/文案后接入断言，未改应用、未把断言降成可选。父会话待 worker 交付并统一 Node build 后重跑本命令，确认 cached/missing 两行实际结果；本轮不可宣布全表全绿。没有发现需修改既有 UI 的确定性 bug；前期测试选择器（关闭按钮重名、刷新遮罩命中、时间补零、热力倒序）及异步观察时序均只修正本新脚本。

## 未覆盖

Swift/Xcode、原生 actor、iOS/Safari 真机手势/锁屏/长后台、系统中断，以及真实 Opus/CDN/权限服务均未验。不要把本报告的 Chromium 合成 fixture 结果提升为上述平台结论。

## Parent integration re-run

After all first-round implementations were present, the parent built the Node application afresh and reran this unweakened harness: **8 PASS / 0 FAIL**, exit 0, externalRequestsBlocked=0, serverErrors=[]. The cached Alpha / missing Beta row assertions now pass. The earlier 7/1 result above is retained as an old-build observation, not the current integration verdict. Cold tab-close/offline-new-tab shell+catalog+Blob playback was separately rerun and passed without online page errors. This remains Chromium synthetic verification, not iPhone verification.

## 2026-11-26（issue #7 增量）

新增用例 `paused-reconnect-prefetches-planned-next-without-audio`：离线暂停 → 恢复联网后，计划下一首（队列第 2 行）静默完整入 `anyun-web-audio-v1`；`window.__anyunAudio` 仍 paused、src 不变、播放头不动、无 alert。同时 `offline-recovery…` 用例显式移除该 fixture 缓存条目，以便继续验证「未缓存曲目离线诚实失败」（属夹具复位，非产品行为）。

当轮实测：**10 PASS / 0 FAIL**，exit 0，externalRequestsBlocked=0，serverErrors=[]（连续跑两次结果一致）。仍是 Chromium 合成 fixture，不构成 iPhone/Safari 结论。
