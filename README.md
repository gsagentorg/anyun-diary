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
npm run build      # 用 adapter-vercel 构建到 .vercel/output
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
   脚本走 Blob REST API（无需额外依赖），对象前缀统一 `audio/`，可重跑（覆盖）。
2. **外部静态托管**：把音频放到任意可对公网提供 Range 的站点，设 `PUBLIC_AUDIO_BASE` 指向它（例如自建入口 `<你的生产域名>`）。
3. **随部署包**（不推荐，体积大）：删掉 `.vercelignore` 里的 `static/audio/` 且把它们加回 git。

> ⚠️ 注：音频已从 git **跟踪**中移除，但**历史提交里仍有**（本体 ~266MB）。彻底瘦身需重写历史 + 强推，属破坏性操作，**待确认后执行**。

## 部署到 Vercel

1. 导入仓库 `gsmainagent/anyun-diary`（框架自动识别 SvelteKit）。
2. 环境变量（可选，但强烈建议）：
   - `PUBLIC_AUDIO_BASE` = 托管音频的站点地址，例如自建公网入口 `<你的生产域名>`；留空则用同源 `/audio`。
3. 部署包默认**不含音频**（`.vercelignore` 排除 `static/audio/`，约 264MB）。音频走 `PUBLIC_AUDIO_BASE` 指向的静态托管；若确需随部署包走，删掉该忽略行（注意体积）。

构建产物：`.vercel/output/`。

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
