# 数据发布与部署分离

## 一次性部署

复用 S3 兼容存储（支持 filesystem S3Proxy），不新增服务。本地需要 Node 22+、Python 3、ffmpeg/ffprobe，npm ci 安装依赖。网页支持 adapter-node、adapter-vercel Node runtime；私有签名不能静态导出，首页不预渲染，build 不访问远端目录。

服务器环境（真实值不要提交）：

    CATALOG_STORAGE=s3
    AUDIO_S3_ENDPOINT=https://YOUR-ENDPOINT-HERE
    AUDIO_S3_REGION=YOUR-REGION-HERE
    AUDIO_S3_BUCKET=YOUR-BUCKET-HERE
    AUDIO_S3_ACCESS_KEY_ID=YOUR-ACCESS-KEY-HERE
    AUDIO_S3_SECRET_ACCESS_KEY=YOUR-SECRET-HERE
    AUDIO_S3_PATH_STYLE=1

使用已有 build/start 流程一次性部署。网页服务器只需 GET 权限，本地发布者需要 GET/PUT。密钥只存在发布进程和服务端。未设置 CATALOG_STORAGE 时保留 bundled 兼容模式，旧 local/Blob/S3 后端不移除；只有 s3 目录模式具有本页说明的热更新能力。

## 此后唯一数据更新命令

    node --env-file=YOUR-ENV-FILE-HERE scripts/publish-data.mjs --audio-dir YOUR-AUDIO-DIRECTORY-HERE --lrc-dir YOUR-LRC-DIRECTORY-HERE

也可预先注入环境后省去 --env-file。无需 JSON、清单、仓库内数据；无需重新 build、重启或修改部署包。只能同时运行一个发布者，多发布者最后写入者胜出。

输入为此次完整可见目录，未包含的切片不再展示，但远端正式对象永不删除。音频平面目录支持 m4a/ogg/opus，同 stem 只能一种格式。文件名沿用既有生成器的录像日期、起止偏移和可选 seg 规则。同名 UTF-8 LRC 必须存在；复用原有 LRC offset、同刻歌词和尾行规则。音频 title 标签必须存在；artist、SONG_FMT 沿用生成器规则。缺 title、无法解析偏移、缺 LRC 一律失败，不编造。

切片音频是唯一数据源，env + 音频目录 + LRC 目录是正常发布契约，不需要旧目录 JSON 或主录像。每条录像由现有切片归组，直接派生 duration=null、segments=[]，不收录无切片录像；不查找、补齐或合并旧元数据，不探查原始录像。这是既定展示语义，无需额外接受开关。

发布前完整派生并转码到 OS 临时目录，输入只读，不写仓库数据。音频 Map 仅保留文件路径，顺序处理至多一份单文件上传 buffer，GET 校验流式计算哈希；RAM 不随全量音频累计。已有 .opus 原样只读复用、不重新编码，其他格式转码到临时文件。需预留转码结果的临时盘空间。先 PUT 内容哈希音频并 GET 校验，再 PUT 内容哈希目录并 GET 校验，最后 PUT catalog/current.json。相同 key 对应相同内容，不覆盖不同正式内容，无 DELETE、无自动重试。中途失败保留旧指针；最后 PUT 若网络超时结果不确定，先读 current 确认再重试。

网页初次加载及每 30 秒请求同源 /api/catalog。每次服务端解析 current 和哈希验证的快照，无进程缓存，warm serverless 实例也读最新。首页和播放器会话恢复使用同一目录；现有播放队列不被刷新打断，新建列表用最新数据。失败 API 返回 503、页面显式报错并保留上次目录，不静默变空。current/API no-store；内容哈希快照和音频可长期缓存，目录不含限时签名 URL。

发布不调用 PutBucketCors，S3Proxy 不支持不会阻塞。内容哈希 `objects/<hash>.opus` 总是走同源签名 API，独立于旧 `PUBLIC_AUDIO_STORAGE` 的 local/Blob/S3 选择，且不加旧 `audio/` 前缀。普通音频使用限时签名重定向；若使用 WebAudio 跨域功能，在对象服务或反向代理配置网页来源 GET/HEAD、Range 与 Content-Range 等 CORS。支持标准桶 CORS 的后端仍可单独使用原 migrate-audio configure-cors 命令，本发布流程不修改桶设置。

验证：npm run check、npm test、npm run build。test:catalog 纯内存 mock 验证同一 reader 发布后读取新版本、最后切指针、保留旧对象、失败不切换、schema 和哈希拒绝，完全不访问真实存储。

## 旧命令兼容边界

`npm run data` / `scripts/build_data.py` 是旧 bundled 目录的本地生成工具，保留原有骨架更新及显式 `--expand-catalog` 行为；`npm run audio` / `scripts/to-opus.sh` 仍用于旧本地音频目录。它们不发布 S3 current 指针，也不是新发布接口的前置步骤。新接口 `npm run data:publish -- --audio-dir YOUR-AUDIO-DIRECTORY-HERE --lrc-dir YOUR-LRC-DIRECTORY-HERE` 每次从完整切片目录重新派生，新增与删除切片自然反映在新快照中，不要求扩骨架授权或补时长。发布动作本身仍须 owner 明确授权，命令不会自动部署或改变旧 bundled 部署。
