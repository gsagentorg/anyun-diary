# 迁移到 B2（或任意 S3 兼容存储）

`scripts/migrate-s3.mjs` 把现有目录从**已配置源**（`CATALOG_STORAGE=s3` 或 `local`）复制到独立的 S3 兼容目标（例如 Backblaze B2）。源端只读：不删、不改、不重命名。目标端凭据只从 `TARGET_S3_*` 环境变量读取，工具输出不含凭据或真实 URL。

> 边界：本工具由 owner 本人在本地运行。Agent 不持有、也不会请求 B2 密钥；仓库内只保留占位符与测试夹具。代码提交前未连接任何真实 B2，也未对生产写入。

## 1. 前置（owner 在 B2 控制台完成）

1. 建**私有** bucket（不要开公共读）。目标桶建议专用；若与别的数据共用，务必设置独立 `TARGET_S3_PREFIX` 并谨慎使用 `--prune`。
2. 建 **Application Key**，限制到该 bucket，能力按需：
   - 迁移：`listFiles`、`readFiles`、`writeFiles`
   - 仅在需要 `--prune` 时加 `deleteFiles`
   - 不要给账号级 master key。
3. 配 CORS（Bucket Settings → CORS Rules）。浏览器播放会先 307 到存储，最终 GET 是跨域的，且需要 Range：
   - `allowedOrigins`: 应用实际 origin（含本地验收 origin；native 另验 Capacitor origin）
   - `allowedOperations`: `s3_get`、`s3_head`
   - `allowedHeaders`: `range`
   - `exposeHeaders`: `Content-Range`、`Accept-Ranges`、`Content-Length`、`ETag`
   - `maxAgeSeconds`: 例如 3600
4. bucket 保持私有；音频通过应用签发的短期 URL 访问，不要把 bucket 直接公开。

## 2. 环境变量模板（占位符，勿提交真实值）

源端沿用现有配置（二选一）：

```bash
export CATALOG_STORAGE=s3
# 数据根与连接（与线上读取配置相同；以下均为占位符）
export S3_ENDPOINT='https://YOUR-SOURCE-S3-ENDPOINT-HERE'
export S3_REGION='YOUR-SOURCE-REGION-HERE'
export S3_BUCKET='YOUR-SOURCE-BUCKET-HERE'
export S3_ACCESS_KEY_ID='YOUR-SOURCE-ACCESS-KEY-HERE'
export S3_SECRET_ACCESS_KEY='YOUR-SOURCE-SECRET-KEY-HERE'
export S3_FORCE_PATH_STYLE='true'
export S3_PREFIX='YOUR-SOURCE-DATA-PREFIX-HERE/'
# 音频物理前缀按源实际配置自动解析；旧配置可能使用 objects/，无需手写
```

```bash
# local 源则用：
# export CATALOG_STORAGE=local
# export CATALOG_LOCAL_DIR='YOUR-DATA-DIRECTORY-HERE'
```

目标端（B2 常见配置：自定义 endpoint + 关闭 path-style）：

```bash
export TARGET_S3_ENDPOINT='https://s3.YOUR-B2-REGION-HERE.backblazeb2.com'
export TARGET_S3_REGION='YOUR-B2-REGION-HERE'
export TARGET_S3_BUCKET='YOUR-B2-BUCKET-HERE'
export TARGET_S3_ACCESS_KEY_ID='YOUR-B2-KEY-ID-HERE'
export TARGET_S3_SECRET_ACCESS_KEY='YOUR-B2-APPLICATION-KEY-HERE'
export TARGET_S3_FORCE_PATH_STYLE='false'          # B2 用 virtual-host；自建网关可设 true
export TARGET_S3_PREFIX='YOUR-B2-PREFIX-HERE/'      # 可留空；留空表示 bucket 根
# 可选：目标音频物理前缀（默认 <prefix>/audio/，以 / 结尾）
# export TARGET_S3_AUDIO_KEY_PREFIX='YOUR-B2-AUDIO-PREFIX-HERE/'
```

密钥只放在当前 shell 环境或密码管理器中；不要写进仓库、命令行历史、截图或日志。

## 3. 先 dry-run 看占用

```bash
npm run data:migrate-s3 -- --dry-run
```

输出示例（JSON，数值为夹具示意）：

```json
{"ok":true,"dryRun":true,"objects":412,"counts":{"pointer":1,"manifest":1,"month":18,"audio":392},"bytes":123456789,"budgetExceeded":false,"release":"YOUR-RELEASE-HASH-HERE","months":18,"pruned":true,"uploaded":0,"skipped":0,"deleted":0,"retries":0}
```

- `objects`/`bytes` 是计划写入量；`--budget-mb`（默认 1024）超出时给出警告。
- dry-run 不访问目标、不写任何对象。
- 默认 `--window-days 30`：只迁移最近 30 天的音频，并按同一套上海业务月规则重算月块 revision 与 manifest。

常用裁剪方式：

```bash
# 最近 30 天（默认）
npm run data:migrate-s3 -- --dry-run

# 最近 6 个业务月（显式给 --months 时默认关闭 30 天窗口）
npm run data:migrate-s3 -- --dry-run --months 6

# 全量、字节级原样复制（保留源 manifest/current 内容）
npm run data:migrate-s3 -- --dry-run --window-days 0 --months 0
```

## 4. 真实迁移

确认 dry-run 规模与目标 bucket/prefix 无误后：

```bash
# 推荐：最近 30 天
npm run data:migrate-s3

# 或指定窗口 / 月数 / 并发
npm run data:migrate-s3 -- --window-days 90
npm run data:migrate-s3 -- --months 6 --concurrency 4
npm run data:migrate-s3 -- --window-days 0 --months 0 --concurrency 6
```

行为约定：

- 键布局保持：`current.json`、`releases/<releaseId>/manifest.json`、`months/<YYYY-MM>/<revision>.json`、`audio/<hash>.opus`。
- 源音频前缀按实际配置解析（旧配置可能是 `objects/`），复制到目标的音频前缀，不硬编码、不搬错位。
- 并行槽默认 5（`--concurrency 1..16`）。
- 每个对象上传后回读并校验 SHA-256；已存在且哈希一致则跳过，可断点续跑。
- `current.json` **最后写**；只有全部对象校验通过才切换指针。
- 失败即停，保留目标已有状态，退出码非 0；重跑会跳过已完成对象。
- 对 429/5xx/网络错误做有上限的指数退避（默认 4 次重试，单次最长 8 秒），报告 `retries`；4xx 立即失败。
- `--prune` 默认关闭；开启时只在 `current.json` 切换成功后，删除目标端**符合托管键布局**且不在本次计划中的对象。非托管键（例如同桶其他应用的文件）不会删除。仍建议使用专用 bucket/prefix。

迁移范围说明：

- 会复制：指针、当前 release manifest（未裁剪时还包括源上的历史 release manifest）、月块、被引用音频。
- 不会复制：旧版 `manifest.json`（v2 读取不依赖它）、未被任何月块引用的孤儿音频、被窗口裁掉的月与音频。
- 历史 release 在裁剪模式下不复制，避免在目标端留下引用缺失的回滚点。

## 5. 迁移后验收

1. **指针与目录**：把应用临时指向 B2（见回滚节的 env 切换），确认：
   - `/api/current` 返回的 `releaseId` 与迁移输出 `release` 一致；
   - 月列表数量、每块 `count`/`revision` 与目标 manifest 一致；
   - 目标对象数为 `objects`（dry-run/实跑报告）。
2. **音频 Range**：取一个音频稳定端点 `/api/audio/<hash>.opus?resolve=1` 得到短期 URL，然后：
   ```bash
   curl -s -D- -o /dev/null -H 'Range: bytes=0-1' 'YOUR-TEMP-AUDIO-URL'
   ```
   期望 `206 Partial Content` 且有 `Content-Range`/`Accept-Ranges`；越界请求期望 `416` 与 `bytes */size`。
   应用自身对音频是 `307` 重定向到存储，浏览器跟随后的最终响应才是上述 206。
3. **浏览器播放**：在切到 B2 的验收环境播放、拖动进度、暂停恢复；检查控制台无 CORS 错误。
4. **iOS/native**（如适用）：另验 AVPlayer 的 Range、长暂停与后台恢复（本轮工具不改客户端）。
5. 验收完成前不要删除源端任何对象。

## 6. 回滚

源端在迁移中始终未被修改，因此回滚不需要“恢复数据”：

1. **应用回滚**：把应用环境的 `CATALOG_STORAGE`/`S3_*` 改回旧源（旧 bucket/prefix），重启/重新部署后 `/api/current` 应回到旧 release。若只是切换前缀，改回 `S3_PREFIX` 即可。
2. **目标端指针回滚**：若 B2 上已有旧的 `current.json`，把它写回（例如用 B2 CLI/S3 CLI 单对象覆盖）。也可以回滚到目标上某个历史 release：
   ```bash
   npm run data:rollback -- YOUR-RELEASE-HASH-HERE
   ```
   该命令需要与目标存储一致的写环境；它只切指针，不删对象。
3. 本次迁移在失败时不会写 `current.json`，所以“迁移中断”本身不会让 B2 读者看到半成品目录。
4. 待验收与保留期结束后，再由 owner 决定是否清理旧源；工具不自动删除源端。

## 7. 排查

- `Missing S3 configuration: S3_REGION`：源端字段缺失；显式空值不会回退到旧别名。
- `Invalid S3_PREFIX` / `Invalid S3_AUDIO_KEY_PREFIX`：前缀只允许相对路径段（字母/数字/`_`/`-`），音频前缀须以 `/` 结尾。
- `HTTP 403`：密钥能力或 bucket 权限不足；`403` 不会被当作空目录。
- `Target verification failed`：上传后回读哈希不一致；目标可能未提供写后读一致性。停止并由 owner 检查存储行为，不要盲目重跑。
- `Source audio integrity mismatch`：源音频内容与其 `audio/<sha256>.opus` 名称不符；先修源数据，不要迁移。
- `No months retained by migration window`：窗口过窄或源目录为空；放宽 `--window-days`/`--months`。

## 8. 本地验证

```bash
npm run test:migrate-s3
```

覆盖：键布局与旧 `objects/` 音频前缀映射、`TARGET_S3_*`/B2 配置（path-style=false、自定义 endpoint）、并行上限、断点续跑跳过、哈希不一致重传、校验失败不写 `current.json`、dry-run 零写入、window/month 裁剪与 revision 重算、prune 顺序、失败不改源、429/5xx 重试上限、4xx 立即失败。全部为内存 fake S3 与本地 `localStore`，不访问真实 B2。