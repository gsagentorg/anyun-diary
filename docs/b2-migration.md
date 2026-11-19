# 公网发布链迁移：生产 HTTP API → B2（或 Blob）

`scripts/migrate-s3.mjs` 把**内部生产 HTTP API** 上的目录完整复制到独立的公网目标（S3 兼容，推荐 Backblaze B2；或 Vercel Blob）。本链路重建 `9c281cf` 误删的 `migrate-audio` 发布链：接口与语义继承 `af690df` 的 `docs/audio-migration.md`（`SOURCE_AUDIO_BASE`/`AUDIO_S3_*`/`BLOB_*` 原样可用），数据模型升级为 v2 完整对象集。

源端只读：不写、不删、不重命名，绝不触碰生产存储。目标端凭据只从环境变量读取；工具输出不含凭据、端点或 URL。

> 边界：本工具由 owner 本人在本地运行。Agent 不持有、也不会请求 B2/Blob 密钥；仓库内只保留占位符与测试夹具。代码提交前未连接任何真实 B2/Blob，也未对生产写入。

## 0. 目标对象集（v2）

一次完整迁移写入：

- `current.json` —— 指针（**最后写**，全部对象成功后才切换）
- `releases/<releaseId>/manifest.json` —— 当前 release 的月清单
- `months/<YYYY-MM>/<revision>.json` —— 月块（内容寻址）
- `audio/<sha256>.opus` —— 被月块引用的音频（文件名即内容摘要）

S3 目标下音频物理键为 `<prefix>/audio/<hash>.opus`（可用 `AUDIO_S3_KEY_PREFIX` 显式指定，默认 `audio/`）；Blob 目标键与逻辑键一一相同。

## 1. 环境变量模板（占位符，勿提交真实值）

owner 本地已有的旧链 env 原样可用，无需新增变量：

```dotenv
# 源：内部生产 HTTP API（只读）
SOURCE_AUDIO_BASE=https://YOUR-SOURCE-HOST-HERE

# 目标 A：B2（S3 兼容）
AUDIO_S3_ENDPOINT=https://s3.YOUR-B2-REGION-HERE.backblazeb2.com
AUDIO_S3_REGION=YOUR-B2-REGION-HERE
AUDIO_S3_BUCKET=YOUR-B2-BUCKET-HERE
AUDIO_S3_ACCESS_KEY_ID=YOUR-B2-KEY-ID-HERE
AUDIO_S3_SECRET_ACCESS_KEY=YOUR-B2-APPLICATION-KEY-HERE
AUDIO_S3_KEY_PREFIX=audio/
AUDIO_S3_PATH_STYLE=0
```

```dotenv
# 目标 B：Vercel Blob
BLOB_BASE_URL=https://YOUR-BLOB-BASE-URL-HERE
BLOB_READ_WRITE_TOKEN=YOUR-BLOB-READ-WRITE-TOKEN-HERE
# BLOB_ACCESS 缺省 public；private 时目标走 SDK 签名读取
```

- 目标解析优先级：`TARGET_S3_*` > `AUDIO_S3_*` > `S3_*`；设了 `BLOB_READ_WRITE_TOKEN`（且无任何 S3 目标变量）或 `TARGET_STORAGE=blob` 时走 Blob。
- 目标桶建议**私有、专用**；与其他数据共用时设置独立前缀并谨慎使用 `--prune`。
- 密钥只放在仓库外、权限 0600 的 env 文件或当前 shell；不要提交、不要粘贴真实值到日志。
- 源必须支持 `HEAD` 并返回准确 `Content-Length`（个别部署剥离该头时工具会退一次 `Range: bytes=0-1` 取总长）。

## 2. 先 dry-run 看占用（只读源，零目标写入）

```bash
node --env-file=/YOUR-ENV-FILE-HERE scripts/migrate-s3.mjs --dry-run
```

输出示例（JSON，数值为夹具示意）：

```json
{"ok":true,"dryRun":true,"objects":412,"counts":{"pointer":1,"manifest":1,"month":18,"audio":392},"bytes":123456789,"budgetBytes":1073741824,"budgetExceeded":false,"release":"YOUR-RELEASE-HASH-HERE","months":18,"droppedMonths":0,"normalized":false,"pruned":true,"uploaded":0,"skipped":0,"deleted":0,"retries":0}
```

- `objects`/`bytes` 是计划写入量；超过 `--budget-mb`（默认 1024）时警告。
- `droppedMonths`：源 `/api/catalog` 因查询窗口把某些月翻成不可用时，这些月无法读回，会被丢弃并重建 manifest（见 §5）。

## 3. 源 API 读取方式

- `/api/current` 取 `releaseId`（每次运行只取一次并钉住；legacy 无指针时服务端已归一化）。
- `/api/catalog` 取当前 manifest，并校验 `revision` 与钉住的 `releaseId` 一致；迁移中源发布新 release 会直接报错（`Source release changed during migration`），绝不混 release。
- `/api/month/<id>?release=<id>` 取月块（release 钉住；不可用月返回 404）。
- `/api/audio/<hash>.opus` 307 重定向到存储，跟随重定向取音频字节；`HEAD` 同路径取 `Content-Length`。
- 请求不带任何凭据；源端任何失败（含 429）**不自动重试**，直接报错退出。

## 4. 真实迁移

```bash
# 推荐：最近 30 天
node --env-file=/YOUR-ENV-FILE-HERE scripts/migrate-s3.mjs

# 最近 6 个业务月 / 全量
node --env-file=/YOUR-ENV-FILE-HERE scripts/migrate-s3.mjs --months 6
node --env-file=/YOUR-ENV-FILE-HERE scripts/migrate-s3.mjs --window-days 0 --months 0
```

沿用旧链（migrate-audio）的语义：

- **流式不落盘**：音频经内存直传目标，全程无临时文件、无本地缓存。
- **已存在跳过**：目标 key 已存在即跳过，不按大小决定重传；`--verify-full` 才会完整 GET 目标比对 SHA-256，已存在但摘要不同只报错、不重传。
- **B2 无条件 PUT**：不发送 `If-None-Match` 条件头；B2 同 key 上传会创建新版本，因此迁移只补缺失 key。迁移期间不要有其他进程向相同目标 key 写入。
- **429/失败不自动重试**：源与目标均是。429 报错提示后由人工等待后重跑；4xx 立即失败。
- **绝不删源**：源端只读；`--prune` 只删目标端托管键布局内的多余对象（S3 目标专属，Blob 无列举能力，显式报错）。
- **指针最后写**：全部对象校验通过才写 `current.json`；中断不会让目标读者看到半成品目录。
- 上传后 HEAD 目标校验长度；音频另校验内容 SHA-256 与文件名一致、月块 revision 与内容一致（源端完整性）。
- 失败即停、退出码非 0；重跑跳过已完成对象，可断点续跑（不按字节续传）。
- `--concurrency` 并行槽默认 5（1..16）；`--timeout-ms` 每请求超时默认 120000；`--now` 仅测试用。
- 输出与错误信息均脱敏：不含端点、签名或密钥。

## 5. 裁剪与 manifest 重建

- `--window-days N`（默认 30）保留最近 N 天音频；`--months N`（给定时默认关闭天数窗口）保留最近 N 个业务月。0 关闭。
- 裁剪（或下列重建条件触发）时按上海业务月规则重算月块 revision 与 manifest revision，指针指向新 release；未裁剪时原样复制当前 release 的字节。
- `/api/catalog` 会按查询窗口把部分月翻成 `available:false`：这些月读不回来，工具丢弃它们并重建 manifest（`droppedMonths` 计入 summary）。这是源 API 的既定行为，不是数据丢失。
- 月块内音频引用为绝对 URL（旧数据）时自动归一化为 `audio/<hash>.opus`（summary `normalized`）。
- 历史 release manifest 在裁剪/重建模式下不复制（HTTP 源本身也无法枚举历史 release），避免目标留下引用缺失的回滚点。

## 6. 迁移后验收

1. **指针与目录**：把应用临时指向新目标（见回滚节 env 切换），确认：
   - `/api/current` 返回的 `releaseId` 与迁移输出 `release` 一致；
   - 月列表数量、每块 `count`/`revision` 与目标 manifest 一致。
2. **音频 Range**：浏览器/`curl` 对音频稳定端点做 `Range: bytes=0-1` 请求，期望 `206` + `Content-Range`；越界期望 `416`。
3. **浏览器播放**：播放、拖动进度、暂停恢复；检查控制台无 CORS 错误（B2 桶 CORS 需 owner 预先在控制台配置：GET/HEAD、`range` 头、暴露 `Content-Range` 等）。
4. 验收完成前不要删除源端任何对象；源下线由 owner 另行决定，工具不清理源。

## 7. 回滚

源端在迁移中始终未被修改，回滚不需要"恢复数据"：

1. **应用回滚**：把应用环境变量改回旧组合（`PUBLIC_AUDIO_*`/存储配置），重新部署即可。
2. **目标端指针回滚**：若目标已有旧 `current.json`，单对象覆盖写回，或用 `npm run data:rollback -- YOUR-RELEASE-HASH-HERE`（需与目标一致的写环境，只切指针不删对象）。
3. 迁移失败时不写 `current.json`，中断本身不会污染目标目录。

## 8. 排查

- `Invalid SOURCE_AUDIO_BASE`：base 只允许 http(s) origin+子路径，不带查询/fragment/账号密码。
- `Source API request failed (HTTP 429)`：源被限流；按提供商要求等待后人工重跑，无隐藏重试。
- `Target request throttled (HTTP 429)`：目标被限流；同上。
- `Source release changed during migration`：迁移中源发布了新 release；重跑即可（从头钉住新 release）。
- `Destination differs; existing object not uploaded`：`--verify-full` 下目标已有对象与源不一致；人工核查后决定，工具不覆盖。
- `Source audio integrity mismatch`：源音频内容与其 `audio/<sha256>.opus` 名称不符；先修源数据。
- `--prune is unsupported for Blob targets`：Blob 无列举能力，不支持 prune。
- `Source and target resolve to the same location`：源与目标是同一地址；检查 env。

## 9. 本地验证

```bash
npm run test:migrate-s3
```

覆盖：`TARGET_S3_*`/`AUDIO_S3_*` 映射（含 B2 自定义 endpoint 与 path-style）、HTTP mock 源（`/api/current`、`/api/catalog` 含 available 翻转、release 钉住、`/api/audio` 307+Range）、HEAD 探长与 Range 回退、完整 v2 对象集与指针最后写、窗口/月裁剪重算 revision、已存在跳过（无内容读取）、`--verify-full` 全文摘要比对与差异拒绝、源/目标 429 均不自动重试、源超时、release 中途变更检测、Blob 目标全量写入与二次跳过、Blob 拒绝 prune、同地址拒绝。全部为本地 HTTP mock 与内存 fake（S3/Blob），不访问真实 B2/Blob，不使用真实凭据。
