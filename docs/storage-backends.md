# 音频存储后端方案（多存储支持）

状态：设计已定（2026-11-10 owner 拍板）；本档落地 s3 兼容存储，其余两档为路线图。默认迁移直接从已有 HTTP 实例流式传到 S3，不经本地音频文件；以文件为单位下载→上传→检查后释放并发槽，不做整批暂存。默认只 HEAD 大小检查，写入时源 GET 一次、目标不 GET；同大小但内容不同的已有目标可能跳过，大小一致不是密码学完整性证明。`--overwrite` 强制写入；`--verify-full` 才启用源 SHA256、目标完整 GET 校验及摘要一致续跑，增加源重复读取与目标下载成本。可选 `pull` 冷备不属迁移前置。迁移操作手册见 `docs/audio-migration.md`。

## 抽象模型

统一入口是 `audioUrl(opus)`（`src/lib/types.ts`），按配置返回不同形态的 URL；
data.json 曲目只存文件名，存储类型是全局部署配置，不做逐曲目混用。

| 档位 | 配置 | URL 形态 | 状态 |
|---|---|---|---|
| local | 默认（`PUBLIC_AUDIO_BASE` 留空） | 同源 `/audio/<file>` | 已上线 |
| remote 直链 | `PUBLIC_AUDIO_BASE=https://...` | `<base>/audio/<file>` | 已上线（Vercel Blob 即此档实例） |
| s3 兼容 | `PUBLIC_AUDIO_STORAGE=s3` + `AUDIO_S3_*` 私有变量 | `/api/audio-url?f=<file>` → 302 → 预签 URL | 本次实现 |
| 私有 Vercel Blob | （路线图） | 同 s3：端点签限时 URL | 未实现 |

## s3 兼容档（Backblaze B2 / 任意 S3 兼容）

### 为什么 302 而不是 JSON 端点

`audioUrl()` 是同步函数，播放器两处 `a.src = audioUrl(...)` 与 MediaSession 路径都依赖同步语义。
让端点直接 302 到预签 URL，客户端零改动；现代浏览器媒体元素跟随重定向并重发 Range 请求，seek 正常。

### 预签（SigV4 query auth）

- 手写 SigV4（`src/lib/server/s3-presign.ts`），零依赖：canonical request → string-to-sign → HMAC 链 → 追加 `X-Amz-Signature`。
- `UNSIGNED-PAYLOAD`、只签 `host` 头、`X-Amz-Expires` 默认 3600s（上限 604800）。
- 路径风格：默认 virtual-host（`bucket.host`）；`AUDIO_S3_PATH_STYLE=1` 切 path-style（`host/bucket/`）。

### 鉴权边界

- 私有桶：secret key 只存在于服务端（`$env/dynamic/private`），永不下发前端；未配置 = 端点 500/503，不影响其他档。
- 文件名白名单校验（字符集 + `.opus` 后缀，拒绝路径分隔与 `..`），拒绝非法路径（不保证防枚举）；预签 URL 本身限时，泄露窗口有限。
- 公开预签端点可被任何访问者调用，私有桶与限时 URL 不等于用户鉴权、防盗链或防盗刷；需要时另加鉴权、限流与预算控制。

### 环境变量

公共：
- `PUBLIC_AUDIO_STORAGE=local|s3`（默认 local）

私有（服务端）：
- `AUDIO_S3_ENDPOINT`（如 `https://YOUR-S3-HOST-HERE`）
- `AUDIO_S3_REGION`（填 `YOUR-REGION-HERE` 对应实际区域）
- `AUDIO_S3_BUCKET`
- `AUDIO_S3_ACCESS_KEY_ID` / `AUDIO_S3_SECRET_ACCESS_KEY`
- `AUDIO_S3_KEY_PREFIX`（默认 `audio/`）
- `AUDIO_S3_URL_TTL_SECONDS`（默认 3600）
- `AUDIO_S3_PATH_STYLE`（默认 0）

### B2 免费档要点（2026-11-10 调查）

10GB 存储 / 1GB·天⁻¹ 下载（超出 $0.01/GB）；免费档不支持公有直链防盗链，私有桶 + 公开预签端点只保护长期凭据，不提供访问者鉴权或防刷。原生 API 另有 `b2_get_download_authorization`（按前缀签 ≤24h token），本方案选 S3 兼容层以复用标准 SigV4。

## 验证

`npm run test:storage`：SigV4 确定性、URL 结构、排序、过期参数、文件名校验。
