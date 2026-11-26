# 逐曲离线可用性（未发布）

## 显示与操作

范围预览（实际展示的前 20 首）、播放队列、主浏览展开日卡、时间线 linear/compress 两种模式的每个可点击音频块，以及搜索结果，全部使用同一三态观察器：

- 在线：不加缓存标签，不查询缓存。
- 离线、确定完整缓存：原有正常视觉，不加额外标签。
- 离线、确定未完整缓存（含下载尚未完成）：行降低透明度，文字“未完整缓存 · 联网后可重试”。
- 离线、未查询/浏览器不支持/存储拒绝/旧原生桥/桥失败/缺失或畸形回复：不降低透明度，文字“离线可用性未知 · 可尝试播放”。unknown 绝不伪装成未缓存。

标识只是可用性提示：不删除队列，不禁止加入或点击播放，不修改播放器的失败/重试策略。正常缓存行及在线行均不带离线提示文字。

## 来源与更新

所有 UI 入口与实际播放器一致，使用 audioUrl(audio.opus)。不自行拼签名地址、resolve 地址或 anyun-cache scheme，不跨后端复用判定。

- Web：复用现有 getWebAudioEntryState 与 subscribeWebCacheEvents，并对每次判定执行新的 Cache.match。正判定必须是 writer 提交的非 opaque/error 完整 200：音频 Content-Type、正整数 x-anyun-bytes（不超单曲上限）、正 x-anyun-stored-at、存在 body、无 Content-Range；如果包含 Content-Length，必须等于 writer 字节标记。单凭 response 存在或陈旧 sizes 命中绝不视为 cached。存储权限/IO 拒绝、来源标记异常、温索引命中但文件已回收均降为 unknown。查询只读、不下载音频、不读音频体。核心只在冷索引时加载索引；UI 不在 render 时全量扫描缓存。
- App：可选新桥 AnyunCache.mediaStatus({ urls: string[] }) => { statuses: [{ url, cached }] }。单批最多 100，串行分批，按原始 URL 精确对应回复；重复、缺失、非 boolean 行未知。旧壳没有方法或拒绝调用时保持未知，仍可点击尝试播放。原生侧需只对实际可读完整音频返回 true。
- 在线/离线事件、窗口 focus、列表改变、backend.base/backend.generation 改变均撤销旧异步所有权并重新判定。Web 写入/失败/逐出/清空事件实时失效。
- 原生桥契约不包含推送通知：本模块 clear/setPolicy 封装即时通知媒体状态；AVPlayer 后台预取、OS 逐出通过离线且有可见列表时每 15 秒轮询、重新 focus 时更新。后台 document.hidden 不轮询。隐藏列表传空 targets，不查询。
- 观察器订阅惰性创建，最后订阅者销毁后清监听及定时器。URL 去重，同列表同 backend 上下文不重复 IO。主浏览沿用 ContinuousBrowse 的挂载/虚拟窗口 audios，日卡只查询已展开歌曲，时间线未布局不查询，搜索关闭传空 targets；不扫描整个曲库。

## 离线点选与月块失败

日卡单曲/替换当天、时间线单曲/替换当天均通过 resolveBrowseAudios 保留点击时 audio 快照。如果 loadMonth 网络/目录加载失败，仍允许尝试已有稳定音频源；成功则优先使用完整歌词等元数据。每次操作同月份只加载一次。

AbortError、操作取消、组件销毁、backend.base/generation 改变不允许降级到旧快照：抛 AbortError 并由组件退役该操作，不提交播放/队列变更。最新点击使用 createLatestOperation 所有权，旧月块迟到不能覆盖新播放意图。搜索结果已含当前 audio，保持原有直接播放入口。

## 资源与所有权

每个列表观察器最多一批在途，原生每批 <=100 URL；Web 每批最多 8 个条目状态读取并发。批次结果仅能提交给同一 epoch 的当前列表和后端。状态缓存仅保留当前展示列表，不永久累积整个曲库。

5 秒仍未完成的查询保留未知，迟到结果不提交；底层 Promise 未结束前仍占唯一 IO 槽，避免无法中止的旧桥调用在更新/轮询时无限堆积。代价是底层永久挂起时本观察器后续查询保持未知直到组件重建，不会拖死播放/列表操作。不会用超时冒充 missing，也不会凭空把一次网络在线信号当“已缓存”。

缓存提示是一次快照，不是离线播放担保：浏览器/OS 可在查询后回收缓存，navigator.onLine 也不能代表某服务实际可达；播放器最终尝试与错误提示仍是权威。Web 复用核心内存索引，外部清理/其他 tab 未发出的缓存变更不会获得本 tab 的即时推送。

## 验证

运行 node_modules/.bin/vite-node scripts/test-offline-availability.mjs。使用纯合成 URL、Response 与桥替身，不读取真目录、真音频或凭据。覆盖三态、100 条分批、8 并发、去重、online/offline、缓存失效、后端/列表所有权、迟到/挂起/拒绝、轮询销毁、浏览器不支持/权限拒绝；从五个真实组件抽取六种行/块模板编译为 Svelte SSR，断言仅 missing 变暗、cached 保持、unknown 文案、在线不打标、操作按钮不禁用。

续修结果：offline-availability 131 条行为/SSR 断言通过（六种实际行/块模板，含时间线双模式），check 0 errors/0 warnings；首轮回归结果：native-cache 59、web-offline 124、ios-cache 142 条源码断言、player-ops 26，以及 playlist、interactions、queue-budget、native-audio 均通过。

测试不等价于完整页面浏览器交互或原生执行。此 Linux 环境没有 Swift/Xcode，未执行 Swift 编译或 iPhone 真机验证。

### 本轮原始失败记录（均定位后修改相应测试，不对未改命令盲重试）

1. 首次 SSR fixture 抽取多取一个字符：InternalCompileError: Unexpected token；code: js_parse_error；filename: offline-row-fixture.svelte；末尾实际为 {/each}{。修正结束位置使用关闭标签真实长度。
2. 修正抽取后的测试暴露 vite-node 不提供完整 import.meta：TypeError: __vite_ssr_import_meta__.resolve is not a function（当时 scripts/test-offline-availability.mjs:112）。改为 Node createRequire.resolve + pathToFileURL 解析 SSR runtime。

3. 父会话续修期间的 Capacitor 构建观测到暂态源码错误：offline-availability.ts:27 的正则斜杠缺少转义。已取消该正则，改用 type.startsWith('audio/') / type.startsWith('video/')，续修 check 与 131 断言通过。父会话负责源码稳定后的最终双构建；此子任务未运行构建。

## 核心 API 仍需明确的边界

本模块对正常 writer 的原子完整 Response 提交及字节标记有信任边界，不会为每个视觉提示读取完整音频体来再算实际字节长度。外部代码恶意伪造全部合法标记但放入短 body，不能被只读 header 检查识别。应在核心共用完整性校验、读回播放校验中覆盖，而不是 UI 全量搬运媒体。

现有核心 getWebAudioEntryState 把 live Blob 和陈旧 sizes 都称 cached，无法只用公开状态 API 区分“磁盘已被 OS 回收、但当前完整 Blob 还可播”和“只有陈旧索引”。此模块 fresh match 缺失时保守 unknown，不误宣称完整缓存/确定未缓存。建议核心导出能区分内存租约与实际磁盘状态的只读状态接口，并复用同一 writer/reader 证据；现有 acquireCachedAudio 对读回字节只校验非空，invalidateCachedAudio 也不发变更事件，这两处值得核心单独补测。此次无核心文件写权限，未越界更改。

未改 package.json（分文件所有权限制）；集成者已可在自己的权限内纳入总测试入口。
