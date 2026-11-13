# 音频存储迁移指南（已有实例 → 本地 / Vercel Blob / S3 私有桶）

> 背景与档位设计见 `docs/storage-backends.md`。本档是操作手册：把音频从**已有实例**
> （当前权威副本所在的托管站点）迁移到新目标，并完成前端 env 切换。
>
> 权威清单 = `src/lib/data.json`（`recordings[].clips[].opus`，当前 466 个）。
> 仓内 `static/audio/` 不进 git，本地副本只在本机存在。

## 0. 迁移前认知

- **音频的权威副本目前只在已有实例上**（仓库里没有）。迁移第一步永远是把它拉回本地，
  之后任何目标都从本地出发。**在 verify 通过前，不要动旧实例、不要删任何远端对象。**
- 迁移期间旧实例保持只读可用；前端切 env 的瞬间才开始消费新存储（蓝绿切换，无中间态）。
- 所有脚本都幂等：重复执行自动跳过已一致的对象，中断了直接重跑。

## 1. 工具一览

| 命令 | 方向 | 说明 |
|---|---|---|
| `node scripts/migrate-audio.mjs pull --from=<旧实例base>` | 旧实例 → 本地 | 按 data.json 清单下载到 `static/audio/`，Content-Length 一致自动跳过 |
| `node scripts/migrate-audio.mjs verify` | 本地自检 | 对照清单查缺失/空文件/非 OggS 魔数/清单外文件；退出码 0=通过 |
| `node scripts/migrate-audio.mjs push-s3` | 本地 → S3 私有桶 | 读 `AUDIO_S3_*` env，SigV4 预签 PUT；`--dry-run` 先演练 |
| `BLOB_READ_WRITE_TOKEN=... node scripts/upload-blob.mjs` | 本地 → Vercel Blob | 既有脚本，见其文件头注释 |

清单变化后（新增切片等）重跑 pull/verify 即可覆盖增量；data.json 是唯一清单来源，**不要手写文件列表**。

## 2. 阶段一：从已有实例拉回本地

前置：拿到旧实例的音频 base（即当前线上 `PUBLIC_AUDIO_BASE` 的值，形如
`https://xxxx.public.blob.vercel-storage.com`；若旧实例是同源部署，则填站点 origin 本身）。

```bash
node scripts/migrate-audio.mjs pull --from=https://<旧实例音频base>
node scripts/migrate-audio.mjs verify          # 必须 ✅ 才能进下一阶段
```

- 可选：`--concurrency=6`（默认）调并发；`--force` 忽略长度一致跳过、全量重拉。
- 中途失败会列出失败文件；直接重跑，已完成的自动跳过。
- verify 退出码：`0` 通过 / `2` 有缺失或损坏 / `3` 下载失败。**非 0 不许继续。**
- 本地副本建议立刻做一份冷备（它现在是唯一非远端副本）：
  `tar -C static -czf ~/audio-snapshot-$(date +%F).tgz audio`

## 3A. 阶段二A：目标 = 本地/自托管（同源直连）

把 `static/audio/` 放到站点同源可服务路径（本地 `npm run dev` 与自托管 SvelteKit 都天然
serve `static/`），前端 env：

```
PUBLIC_AUDIO_STORAGE=      # 留空或 local
PUBLIC_AUDIO_BASE=         # 留空 = 同源 /audio/<file>
```

不需要任何其他变量。带宽/磁盘自己扛即可；只有当站点部署在无宽音频托管（如 Vercel）时才不适用。

## 3B. 阶段二B：目标 = 新的 Vercel Blob Store

```bash
BLOB_READ_WRITE_TOKEN=<新store的token> node scripts/upload-blob.mjs
```

完成后前端 env（Vercel 项目 Settings → Environment Variables，或本地 `.env`）：

```
PUBLIC_AUDIO_STORAGE=
PUBLIC_AUDIO_BASE=<脚本末尾打印的 base>     # 如 https://xxxx.public.blob.vercel-storage.com
```

## 3C. 阶段二C：目标 = S3 兼容私有桶（B2 等）

先配好 env（两边都配好，owner 负责；本地放 `.env`，部署侧放对应平台）：

```
PUBLIC_AUDIO_STORAGE=s3
AUDIO_S3_ENDPOINT=https://s3.<region>.backblazeb2.com   # 示例
AUDIO_S3_REGION=<region>
AUDIO_S3_BUCKET=<bucket>
AUDIO_S3_ACCESS_KEY_ID=<key>
AUDIO_S3_SECRET_ACCESS_KEY=<secret>
AUDIO_S3_KEY_PREFIX=audio/
AUDIO_S3_URL_TTL_SECONDS=3600
AUDIO_S3_PATH_STYLE=0        # B2 用 virtual-host 默认即可
```

推送（凭据只从 env 读，不进任何文件/git）：

```bash
node scripts/migrate-audio.mjs push-s3 --dry-run   # 先看清单与目标
node scripts/migrate-audio.mjs push-s3             # 真推；重复执行会覆盖同名对象（安全）
```

s3 档下前端无需 `PUBLIC_AUDIO_BASE`；播放走 `/api/audio-url` → 302 → 限时预签 URL。

## 4. 阶段三：切换与验收

1. **部署前自检**（新实例或本地起 dev）：随机抽 3 首，播放、拖动 seek（Range 请求）、
   MediaSession 锁屏控制各验一次；浏览器 Network 面板确认音频请求全部落在新目标上、零 404。
2. **切 env**：目标平台（Vercel 项目或本地 service）写入第 3 节对应组合，重新部署/重启。
3. **线上验收**：线上打开站点，重复第 1 步抽样；另验一个冷门曲目（验证非浏览器缓存命中）。
4. s3 档加验：直接 `curl -sI https://<站点>/api/audio-url?f=<任一opus>` 应 302 且 Location 带
   `X-Amz-Signature`；伪造文件名 `f=../evil` 应被拒（4xx）。

## 5. 回滚

任何一步验收不过：把 `PUBLIC_AUDIO_BASE`/`PUBLIC_AUDIO_STORAGE` 改回旧组合（旧实例全程未动、
一直在线），重新部署即回旧实例。s3 档回滚同理（`PUBLIC_AUDIO_STORAGE` 留空 + 恢复旧
`PUBLIC_AUDIO_BASE`）。确认新目标稳定运行 ≥1 周后，才考虑下线旧实例的音频对象。

## 6. 已知注意点

- 文件名含空格/中文/冒号/点号（切片时间戳命名），脚本侧已用 URI 编码处理；若手动 curl，
  记得自己 `--data-urlencode` 或引号包 URL。
- Blob store 的对象名带 `audio/` 前缀；`--prefix` 改了的话两边（上传与 `PUBLIC_AUDIO_BASE` 路径）
  必须同步改。
- `push-s3` 未配 `AUDIO_S3_*` 会直接退出报缺哪个变量，不会半途裸奔。
- B2 免费档 1GB/天下出流量：迁移总大小（466 × ~几百KB ≈ 百余 MB）一次拉取无压力，
  但别设太高的 pull 并发把出口打满。
