# 安允日记 · 直播歌单时间线

把主播直播间的每日录像做成可浏览、可试听、可导出播放列表的歌单时间线（直播间地址由 `PUBLIC_LIVE_ROOM_ID` 配置）。

- **数据零手填**：全部由**文件名时间戳 + 切片自带的元数据**自动生成，不人工录入。
- **三种视图**：泳道时间轴 / 日卡片 / 热力图。
- **内置播放器**：点击任意歌块即播，支持上/下一首、进度、**睡眠定时器**。
- **动态播放列表**：按 URL 时间范围或面板自定义范围生成，仅在浏览器内播放（外部播放器导出已移除）。

> 注：“有音频但没识别出歌”的片段属录制导致，不代表开播，界面不展示。

## 技术栈

SvelteKit 2（Svelte 5 runes）+ Vite 7 + Tailwind CSS 4 + `lucide-svelte` 图标。
部署目标：**Vercel**（`@sveltejs/adapter-vercel`）。

## 前端重构（已合并 main · 2026-10-18 发版）

在 `refactor/frontend` 分支上完成的一次视觉/响应式重做，主分支不受影响。

- **设计 token**：单一来源在 `src/app.css` 的 `@theme`（语义字号 `--text-2xs/xs/sm/base/lg/xl`、圆角 `--radius-sm/md/lg`、`--color-*`），组件不再写任意值字号/圆角。
- **共享组件**（`src/lib/components/`）：`Chip.svelte`（胶囊徽标）、`HourAxis.svelte`（泳道/热力共用时间轴，按容器宽自适应 2h/3h/6h 刻度）、`Sheet.svelte`（叠层容器，队列叠层用）、`QueueOverlay.svelte`（播放队列叠层：跳播/移出/上下移/清空）、`StateHint.svelte`（空列表/无数据/加载态）。
- **配色选型页**：`static/design-variants.html`（`/design-variants.html`），可选主题/布局方案并导出 token。

详见 `docs/frontend-refactor-plan.md`。

## 快速开始

```bash
npm install
npm run dev        # http://127.0.0.1:5173（配置里监听 0.0.0.0:4173 时以 vite.config.ts 为准）
npm run check      # svelte-kit sync + svelte-check
npm run build      # 默认 adapter-node；DEPLOY_TARGET=vercel 时输出 .vercel/output
```

### 测试（仅本地，不部署）

使用 Node.js `^20.19.0 || >=22.12.0`（与 Vite 7 一致），先执行 `npm ci`。
测试执行器固定为开发依赖 `vite-node@3.2.4`，支持 Vite 7，
与锁文件中的 Vite 7.3.7 共用同一版本；不要用临时下载最新版的 `npx vite-node` 代替锁文件。

```bash
npm test                # 依次运行以下七套；任何断言/套件失败即非零退出
npm run test:data       # Python 3：LRC 更新边界、零目录扫描、原子写入和失败不清词
npm run test:lyrics     # 歌词下标/同刻分组：面板闪过整组、元数据只推首行
npm run test:playlist   # 合成夹具：范围、排序、日期、M3U URL 精确编码
npm run test:shuffle    # 固定种子、40 次抽取及非空覆盖检查
npm run test:lane-scale # 泳道布局/映射
npm run test:session    # 会话恢复、队列、LIFO、倍速
npm run test:sleep      # 睡眠曲线、音频增益、定时器及取消
```

每套使用独立进程，避免会话/睡眠测试的全局浏览器桩、假时钟和 `process.exit`
影响其他套件。播放列表使用合成数据，不依赖 NAS、真实音频或不断增加的录制日期；
会话套件仍读取仓库内 `src/lib/data.json`（只读）。
`npm test` 不运行数据生成、音频转换、构建、部署或服务重启。
睡眠测试是模拟环境下的逻辑验证，不代表 iPhone 锁屏/后台真机验收。

### 更新歌词（现有切片清单不变）

`src/lib/data.json` 是现有切片清单；最终 LRC 目录是本次换词的唯一外部输入。

```bash
export TAGGED_DIR=<最终同名LRC所在目录>
npm run data -- --dry-run  # 检查，不写入
npm run data              # 只更新现有切片的 lyrics
```

- 按 data.json 中每个切片的文件名读取同名 `.lrc`，不枚举素材目录，不读或探查录像、LLC、音频标签、时长缓存。
- 不新增/删除切片，不改变标题、起止偏移、分组或其他既有字段；只有歌词实际变化时更新 `generatedAt`。无变化则文件字节和时间均不改。
- 缺失、空或无效 LRC、时间越界、源文件变化或 data.json 并发变化时，失败退出且不写入；不会把读取失败当成“无歌词”清空旧词。
- 同一时间戳的多行（合唱/同唱）按源顺序全部保留：歌词面板整组快速闪过，系统媒体浮层只推送组内第一行。时间戳必须非递减（同刻允许、倒序拒绝）。
- 末行因整秒取整略超出切片尾部（实测 274 行）时**数据层按源值保留并计数报告**；展示层将其视为正好收在音频结尾（到结尾即点亮、同刻成组快速闪过、元数据推首行）；若 lrc 首行就超出切片尾部则视为拿错文件，拒绝导入。
- 兼容旧 `AUDIO_ROOT` 环境变量，但仅将其拼成 `已打标签/` 路径，不扫描该根目录。优先使用 `TAGGED_DIR` 消除歧义。
- 可用 `--data-file <现有JSON>` 指定独立验证副本。缺少现有清单会报错，绝不回退扫描原始素材。
- `--expand-catalog`：**仅在你明确要求扩容后使用**——扫描 TAGGED_DIR 里的切片音频（文件名承载偏移、ffprobe 读切片自带 tag 除标题外不探查媒体），把目录里没有的切片加入 existing 录音骨架，只增不删；既有条目与字段不动。副产物计入：无词期曲数、尾越界行数、非段名音频跳过计数。

### 音频与新切片

现有音频转换入口与歌词更新分开：`AUDIO_ROOT=<切片素材根> npm run audio` 将 `已打标签/` 内的切片转成 opus；只更新 LRC 时不要运行它。

`npm run data` **不承担新曲导入或从零建库**。新增/移除切片、调整切片标签属于另一个清单更新操作，须单独确认范围，不能借换词顺便扫描其他输入。

本地预览使用 `npm run dev`；歌词数据变化后 dev 自动热更。直播间区块可通过 `.env` 的 `PUBLIC_LIVE_ROOM_ID` 配置。

### 发版（本地生产）
```
npm run build && systemctl --user restart anyun-diary-web
```
生产 = `<你的生产域名>`（由 frpc 配置提供）；开发 = `<你的开发域名>`（由 frpc 配置提供）

## 目录结构

```
src/
  app.css                     # Tailwind 主题（base-*/accent/warning）
  routes/
    +page.svelte              # 三视图切换 + 播放列表面板入口
  lib/
    types.ts                  # 类型 + 纯工具（blocksOf/audioUrl/格式化/Track）
    playlist-core.ts          # 纯逻辑：按时间范围取曲、m3u 生成、日期解析
    player.svelte.ts          # 播放器内核：播放列表、上/下一首、睡眠定时器
    Player.svelte             # 底部播放条（含睡眠定时器菜单）
    Playlist.svelte           # 动态播放列表面板（范围选择 / 生成并插入队列）
    Timeline.svelte           # 泳道时间轴
    DayStrip.svelte           # 日卡片
    Heatmap.svelte            # 热力图
    data.json                 # 自动生成的数据（勿手改）
scripts/                      # 数据管线 / 转码 / 校验 / 单测
static/audio/                 # 155 个 opus 切片（不进 Vercel 部署包，见 .vercelignore）
```

## 播放列表用法

| 入口 | 行为 |
| --- | --- |
| URL | `/?from=2026-10-04&to=2026-10-05` 打开即装载该范围（Asia/Shanghai，含 to 当天） |
| 顶部「播放列表」 | 打开面板：自定义范围、生成并插入队列 |
| 各视图「列表」按钮 | 时间轴 / 日卡片 / 热力图每行一个，一键把该场次全部曲目加入列表 |

> 外部播放器导出（m3u 端点 / VLC 直开 / 复制链接 / 下载）已移除；队列与生成器仅在浏览器内。

## 睡眠定时器

播放条上的月亮按钮：预设 10/15/30/45/60/90 分钟、**自定义分钟数**、「播完当前曲目后就停」，激活时显示倒计时，可随时取消。

## 音频托管（不进 git）

155 个 opus（264MB）是**可从 NAS 切片重新生成的产物**（`npm run audio`），因此：

- **不进 git 跟踪**（`.gitignore` 已排除 `static/audio/`），也不进 Vercel 部署包（`.vercelignore`）。
- 站点按 `${PUBLIC_AUDIO_BASE}/audio/<文件名>` 取音频；留空则用同源 `/audio`。

三种托管方式：

1. **Vercel Blob**（推荐，Vercel 原生对象存储，支持 Range）：
   ```bash
   # 在 Vercel 项目里创建 Blob Store，拿到 BLOB_READ_WRITE_TOKEN
   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx node scripts/upload-blob.mjs
   # 输出 PUBLIC_AUDIO_BASE=https://xxxx.public.blob.vercel-storage.com → 配到项目环境变量
   ```
   脚本使用官方 `@vercel/blob` SDK，对象路径固定为 `audio/<原文件名>`，不添加随机后缀。默认跳过已存在的非空对象；需要覆盖时显式加 `--overwrite`。
2. **外部静态托管**：把音频放到任意可对公网提供 Range 的站点，设 `PUBLIC_AUDIO_BASE` 指向它（例如自建入口 `<你的生产域名>`）。
3. **随部署包**（不推荐，体积大）：删掉 `.vercelignore` 里的 `static/audio/` 且把它们加回 git。

> ⚠️ 注：音频已从 git **跟踪**中移除，但**历史提交里仍有**（本体 ~266MB）。彻底瘦身需重写历史 + 强推，属破坏性操作，**待确认后执行**。

## 部署到 Vercel

1. 在 Vercel 导入仓库，Framework Preset 选择 **SvelteKit**，根目录为仓库根。
2. Node.js 选择 **22.x**（`package.json` 已固定版本），构建命令 `npm run build`，安装命令 `npm ci`；输出目录保持框架默认。`vercel.json` 已提供框架和命令配置。
3. Vercel 设置 `VERCEL=1` 时自动使用 `adapter-vercel`；也可以显式配置 `DEPLOY_TARGET=vercel`。本地/自托管默认仍使用 `adapter-node`，显式 `DEPLOY_TARGET=node` 可覆盖自动检测。
4. 给 Production / Preview 配置 `PUBLIC_AUDIO_BASE`（已有音频站或迁移后的 Blob 基础地址，不带 `/audio`）；需要直播区块时配置数字 `PUBLIC_LIVE_ROOM_ID`。
5. 点击 Deploy；切换音频地址后重新部署。若希望该分支直接作为生产版本，在 Vercel 将 Production Branch 设为 `deploy/vercel`。

构建产物：`.vercel/output/`。不要把 Output Directory 改成 `build`。
构建直接使用已提交的 `src/lib/data.json`，不运行数据生成或音频转换。

### 从已有 PUBLIC_AUDIO_BASE 一次性迁移到 Blob

已有部署的音频地址仍可直接用于 Vercel；若希望改用 Blob，可自动下载并重上传，无需本地音频目录。
先在 Vercel 项目的 Storage 中创建 **Public** Blob Store，并获取 `BLOB_READ_WRITE_TOKEN`。
在仓库根目录执行（Node.js 22，先 `npm ci`）：

```bash
# 基础地址不带 /audio，支持 https://旧站点/子目录 形式
export SOURCE_AUDIO_BASE='https://旧音频站点.example.com'

# 预览清单：不联网、不需要令牌、不下载或上传
npm run audio:migrate -- --dry-run

# 在本地终端安全输入令牌（不写入 shell 历史；bash / zsh）
read -r -s BLOB_READ_WRITE_TOKEN
export BLOB_READ_WRITE_TOKEN
npm run audio:migrate
unset BLOB_READ_WRITE_TOKEN
```

也可以仅导出旧 `PUBLIC_AUDIO_BASE`：未指定 `SOURCE_AUDIO_BASE` 时会自动使用它。
命令只读取进程环境，不自动加载 `.env`；若配置已在 `.env` 中，可以执行：

```bash
node --env-file=.env scripts/upload-blob.mjs --from-remote --dry-run
node --env-file=.env scripts/upload-blob.mjs --from-remote
```

- 从 `data.json` 的 `recordings[].clips[].opus` 获取并去重文件名，只迁移歌单中引用的音频。
- 下载 `${SOURCE_AUDIO_BASE}/audio/<编码后的文件名>`，校验非空、Ogg Opus 头、已知长度，拒绝 HTML 错误页；单文件上限 128 MiB，默认并发 4，可加 `--concurrency=2` 降低内存占用。
- 使用官方 Blob SDK，上传为 Public、保留 `audio/<原文件名>`，不添加随机后缀。令牌只发送给 Blob，下载源无需 Blob 令牌。
- 每个文件最多尝试 3 次；失败后非零退出。可直接重跑：默认跳过目标已存在的非空文件，不校验其内容是否与旧站一致；要更新已有文件请加 `--overwrite`。
- 全部成功后输出 `PUBLIC_AUDIO_BASE=https://xxx.public.blob.vercel-storage.com`，把它填入 Vercel 项目环境变量，再重新部署。部分失败不会输出新的地址，也不会自动修改旧部署或环境变量。
- 上传成功的文件会保留，下载内容仅暂存在内存，不落盘、不进 Git；后续无需旧音频站持续在线。
- 迁移是单独命令，不放进构建流程，避免每次发布重复传输或依赖旧站可用性。

本地已有音频时用 `npm run audio:upload`；预览为 `npm run audio:upload -- --dry-run`。
离线迁移逻辑验证：`npm run test:blob`（模拟下载和 Blob，不访问真实存储）。

## 本地常驻（可选）

本项目常驻三件套（systemd user 单元）：生产 node 服务、开发 vite dev、独立 frpc（**不触碰系统 frpc**）：

```bash
systemctl --user status anyun-diary-web.service    # 生产（adapter-node build，:4173）
systemctl --user status anyun-diary-dev.service    # 开发（vite dev，:5173）
systemctl --user status anyun-diary-frpc.service   # frpc（独立配置/凭据，不碰系统 frpc）
# 隧道：<你的生产域名> / <你的开发域名>（地址由 frpc 配置提供）
```

> 注意：frpc 的 `serverAddr` 钉的是内网 LAN 地址（由 frpc 配置提供）。域名在容器/公网 DNS
> 下若解析到另一台机器，而那边的 frps 不被 nginx 前置——注册“成功”也不会路由（曾导致整站 404）。

## 已知限制

- **跨平台注意**：runes 模块的导入必须写全后缀——`./player.svelte.ts`、`./theme.svelte.ts`（不是 `./player.svelte`）。
  `.svelte.ts` 后缀是 Svelte 5 模块级 runes（`$state/$derived`）必需的，不能改名；而裸写的 `./player.svelte`
  在 macOS 大小写不敏感盘上会先命中同名组件 `Player.svelte`，esbuild 依赖扫描直接报
  `No matching export`（2026-11-07 已把全部 13 处导入改为显式 `.ts`）。tsconfig 需配套
  `allowImportingTsExtensions: true`。

- 既有数据中的时长为空时，前端按未知显示；歌词更新不补查原始素材或时长。
- 「有音频无歌」片段不展示（录制导致，非开播）。

## 待办

- [x] 前端视觉重构（见 `docs/frontend-refactor-plan.md`，已完成于 `refactor/frontend` 分支）
- [ ] 合并 `refactor/frontend` 到 `main` 前重跑 Lighthouse 可访问性验收
