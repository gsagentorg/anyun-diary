# 不可变数据 release 发布

代码只包含 schema、上海业务月规则、local / Vercel Blob / S3 兼容适配器及服务端权限。实际目录与月份对象均属于数据发布层，不进入源码。

## 协议与提交点

- current.json: {"schemaVersion":2,"releaseId":"YOUR-RELEASE-HASH-HERE","key":"releases/YOUR-RELEASE-HASH-HERE/manifest.json"}。真实 releaseId 为完整小写 SHA-256。
- releases/<releaseId>/manifest.json 是完整 schemaVersion=2 月份目录；releaseId = SHA-256(JSON.stringify(months))。
- months/<business-month>/<revision>.json 的 revision = SHA-256(JSON.stringify(audios))，不可变。
- 发布完整权威输入，包含空月；只上传变化月块，复用未变月块。验证所有月份及音频引用和内容摘要，写完整不可变 manifest 并复读验证，最后以单对象覆盖切 current。local 使用同目录临时文件 rename；Blob 使用既有单对象 put。禁止并发发布者；本实现不提供跨发布者 CAS。
- 不自动清理历史月块/release/audio，旧长操作及回滚引用继续有效。另行授权的 GC 必须有引用/保留策略。
- rollbackRelease(store, releaseId) 验证旧完整目录与全部引用后只切 current；真实执行仍需外部写授权。

## 配置与权限

共享 DATA_PERIOD_START_DAY=7，Asia/Shanghai，左闭右开。MAX_QUERY_MONTHS 是部署端查询权限，不再决定发布保留或删除。0 不限；2 是当前业务月及紧邻前一业务月（空月计入）。Vercel 配置 2，MCSM / node 配置 0；不能由 manifest 的 queryMonthLimit / available 放宽，month 与 search API 每次独立执行服务端限制。未新增月数限制；三块缓存只是 LRU 内存预算，不是权限。

CATALOG_STORAGE=local | blob | s3，三者复用同一发布/读取/回滚协议。S3 使用维护中的官方 @aws-sdk/client-s3（旧版手写预签不复用）；S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY 必填，可选 S3_SESSION_TOKEN、S3_ENDPOINT（自部署）、S3_FORCE_PATH_STYLE=true、S3_PREFIX。prefix 只允许相对的字母/数字/_/- 路径段，拒绝点段、空段、编码分隔符。全部凭据仅服务端环境变量，不传浏览器。配置示例见 .env.example；禁止提交真实配置。音频数据在现有 opus 字段保留 audio/<hash>.opus 稳定相对键，不写签名 URL。S3/Blob 同源音频 API 仅 307 重定向至存储/CDN，应用不读取音频字节；local 才同源读字节与 Range。PUBLIC_AUDIO_BASE 不再替代应用解析端点。404 才兼容缺对象，403 不当空目录，5xx/网络/校验失败中止发布。

## 热更新与版本固定

服务端每次读取 current（不在启动时锁死）。Blob current 缓存 1 秒，存储层 release/month 为一年不可变缓存；受权限控制的 month API 使用 no-store，避免跨业务月边界继续使用旧权限缓存；客户端 30 秒/恢复页面仅请求轻量 /api/current，使用 ETag/304；标识包含 release、服务端 MAX_QUERY_MONTHS 与上海业务月，因此权限/7 日边界变化也触发刷新。变化才拉完整目录。预取全部已显示/所需变更块并校验，成功后同步原子切 manifest/months/summaries；任一步失败保留全部上个可浏览版本及错误状态，下次检查重试。目录错误保留上个有效目录，不当空目录。range 固定一次 manifest，month 请求附 release；搜索请求也先固定 release，服务端流始终使用该 release 的 entries。切新目录不会取消同后端旧操作；切换后端则显式取消并清缓存。supply 缓存 key 含 block id / revision / key，实例隔离 backend。旧操作保有自己的 manifest 和结果引用，LRU 驱逐不会改写结果。

## 迁移

current 仅在 404 时显式兼容旧 manifest.json；损坏/空 current、缺失 release 或坏 schema 都报错，不退回旧目录。首次新发布可从旧 manifest 的月范围建立新 release；原来已裁剪的历史块不能凭空恢复，须从完整权威音频/LRC 输入重新发布。新发布不更新旧 manifest.json，旧客户端要迁移到支持 current 的服务端。不要删除旧对象直至旧操作与回滚保留期结束。

命令：npm run data:publish -- --audio-dir YOUR-AUDIO-DIRECTORY-HERE --lrc-dir YOUR-LRC-DIRECTORY-HERE。输入只读；不探查主录像。真实发布另行明确授权。

## 本轮验证范围

mock 覆盖增量复用、原子提交失败、全部引用验证、回滚、local rename / Blob 缓存配置；range 并发热更固定 release、revision 缓存隔离、坏目录保留上个有效版本；原有搜索取消/超时/并发测试。真实 Blob 可见性与生产配置未执行。浏览器回归使用本地隔离服务与合成 fixture（不是生产数据）；API HTTP 测试覆盖 304、显式旧 release 月拒绝与搜索过滤，浏览热更测试覆盖失败保留、成功重试与 range 固定版本。

## S3 运维边界

S3 current/legacy manifest PUT 使用 no-cache,max-age=0,must-revalidate，release/month/audio 使用一年 immutable；读取透传类型/长度/ETag/Range/缓存元数据。所有后端共用上传后复读与摘要验证，最后切 pointer 并复读；最后 PUT 超时或复读失败属于结果不确定，必须重读 current 再决定重试。单发布者，无 CAS，不保证多发布者安全。

回滚命令：npm run data:rollback -- YOUR-RELEASE-HASH-HERE（同一私有存储环境）。仅切指针，不删除历史对象。真实写入另行授权。目标 S3 必须提供对象写后读一致性与原子单对象覆盖；自部署/网关/CDN 的一致性、缓存失效、权限策略、TLS 和音频直连传输行为必须在真实环境另验，本轮仅 mock 与本地 fixture，未接真实 S3。

## 音频直连（不是应用字节代理）

- 发布器只存 `opus: audio/<sha256>.opus`。web player、session 恢复与 native queue 使用稳定 `/api/audio/<hash>.opus`；native 使用已选 backend 的绝对 HTTPS 路径。旧公开 HTTPS opus 为兼容保留；新发布不再固化 URL。解析仅允许这一完整小写 hash 路径，不能请求任意 key/URL，不增加音频月份鉴权。
- S3：配置 `S3_AUDIO_PUBLIC_BASE` 时直接生成安全 HTTPS 公开 URL（基址映射 bucket 根，追加完整物理音频 key）；否则官方 `@aws-sdk/s3-request-presigner` 为单对象 GetObject 短期签名。不签 Range，允许同一 GET URL 请求不同 Range。不向客户端发 SDK 凭据。
- Blob：`BLOB_ACCESS=public` 使用 `BLOB_BASE_URL`。private 使用当前官方 SDK 的 `issueSignedToken({pathname, operations:['get']})` + `presignUrl({operation:'get', access:'private'})`，两者均只在服务器运行，仅最终 URL 出站，不交付 clientSigningToken。SDK 不支持时明确失败 503，绝不手写签名或改走代理。private 元数据使用官方 get；发布 put 的 access 与存储一致。官方参考：https://vercel.com/docs/vercel-blob/vercel-signed-urls 。
- `AUDIO_URL_TTL_SECONDS=900`（1..604800）。每次请求稳定端点重新签发，307 `private,no-store`，对象音频流量直接到存储。队列/session/native 存的是稳定端点和 opus key，不存新签名 URL。目录热更新不替换正在播放的 src、不 configure native 队列。
- **续签与兼容边界**：媒体使用稳定端点的 `?resolve=1` 只读 JSON `{url,expiresAt}` 获得临时直连 URL。web 在 play/过期 seek/媒体错误按需保位重新解析，保存 rate/volume/muted 与播放意图，队列 entry + generation 防旧异步覆盖；连续失败最多两次，不把 NotAllowedError 当签名过期。Native 在 Swift 权威层 URLSession 解析，保 position/暂停意图、原队列/索引/history/rate，ready 后 seek 完成再启动；错误可后台恢复，切歌取消旧任务。正常播放没有定时换 src；公开 expiresAt=null 不续签。网络到期恢复可能短暂缓冲，不承诺绝对无中断。Linux 无 Swift/Xcode/iOS SDK，本轮仅 Swift 源码断言，未编译未真机；仍须真机 iOS Range/长暂停/后台验收。
- 存储/CDN 须允许 GET/HEAD，合法 Range 返回 206 + Content-Range，越界 416 + `bytes */size`，正确 Content-Type/Content-Length/Accept-Ranges；CORS 放行应用 origin（native 另验 capacitor origin）、Range，暴露 Content-Range/Accept-Ranges/Content-Length/ETag；若触发 OPTIONS 要正确响应。无浏览器存储凭据，勿允许携带应用 Cookie/Authorization 至跨域。
- CDN 须保留签名 query 并验证，不能忽略 query 使私有对象变公开，不能缓存 307 或将私有响应跨用户公开；不可变公开 hash 对象可一年 immutable。不要给私有对象直接套公开长期缓存。应用 307 设置 no-referrer；页面/CDN 也应 no-referrer，访问日志/分析/错误追踪不得记录签名 query、Location 或凭据，URL 是临时访问能力，禁止入 git/截图/分享。
- 本地 mock/HTTP 测试验证 302/307 跟随保留 Range 与 206/416；另有 Chromium 合成 WAV 真解码、短有效期服务、长暂停恢复和过期 seek 保位测试，不等同真实对象存储或 AVPlayer 验收。未连接真实存储、未改存储权限/CORS、未部署。

## 旧 S3 配置兼容（ebbddc0）

连接字段逐项采用显式 S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/SESSION_TOKEN，否则 AUDIO_S3_ 同名字段；显式空值不回退，必需字段缺失只报字段名。S3_FORCE_PATH_STYLE 优先于 AUDIO_S3_PATH_STYLE，接受 true/false/1/0，默认 virtual-host。TTL 优先级 AUDIO_URL_TTL_SECONDS > S3_URL_TTL_SECONDS > AUDIO_S3_URL_TTL_SECONDS > 900，合法整数 1..604800。

S3_PREFIX **只定义数据根**（current/releases/months/legacy manifest），不借用 AUDIO_S3_KEY_PREFIX。旧实现对普通文件名使用 AUDIO_S3_KEY_PREFIX（默认 audio/），但对不可变 objects/<hash>.opus 明确绕过该 prefix；本实现逻辑 audio/<hash>.opus 在存在旧 AUDIO_S3 配置时映射到该既有 objects/<hash>.opus，绝不机械拼接 audio/audio、不搬旧对象。纯新配置保持 S3_PREFIX/audio/<hash>.opus；显式 S3_AUDIO_KEY_PREFIX 可覆盖完整音频物理前缀（以 / 结尾），不隐式追加数据根。SDK 读写/发布引用校验/回滚/签名/公开 URL 共用此映射。S3_AUDIO_PUBLIC_BASE 是 bucket 根对应的 HTTPS/CDN 基址，追加完整物理 key；勿再把 S3_PREFIX 写入基址造成双前缀。旧文件名音频不自动变成 hash，须继续使用旧实例/旧目录，不能凭空推断 hash。

兼容配置不等于迁移目录。不得自动发布或覆盖旧 manifest/current pointer；v2 必须另行明确授权，以独立 S3_PREFIX 发布和验收，再人工切读取配置。运行时仅只读；现有发布/rollback CLI 均为显式写操作，未得到授权不得执行。无自动对象重命名、复制或删除，无 bucket/凭据替换。
