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

### 生成数据（可选，需先有 NAS/素材）

```bash
npm run data       # scripts/build_data.py → 解析切片（唯一数据源）+ 可选录像/llc 增强 → src/lib/data.json
npm run audio      # scripts/to-opus.sh → 切片转 64kbps opus 到 static/audio/
```

### 数据同步（日常导入，幂等可重跑）
1. 打标切片落 `${AUDIO_ROOT}/已打标签/`（文件名=录像名+起止偏移，歌名在自带 tag；**切片是唯一数据源**）
2. `npm run audio` → 全量转 64k opus 进 static/audio（已有的自动跳过）
3. `npm run data` → 重建 data.json（录像时长/llc 段均为可选增强，缺失不丢歌）
dev 自动热更。

### 如果我有音频，这个前端怎么用

三步把自有素材接进来（不改任何代码）：

1. **切片命名约定**：打标切片放 `${AUDIO_ROOT}/已打标签/`，文件名形如
   `YYYY-MM-DD HH-MM-SS-HH.MM.SS.mmm-HH.MM.SSS.mmm-segN.m4a|.ogg`
   （= 录像名 + 录像内起止偏移；歌名写在切片文件自带的 tag 里）。
   主录像（`YYYY-MM-DD HH-MM-SS.mp4|.mkv`）与 `*-proj.llc` 放 `${AUDIO_ROOT}/` 根目录，缺失也不丢歌（仅少时长/区间增强）。
2. **设环境变量 + 转码 + 生成数据**：
   ```bash
   export AUDIO_ROOT=<你的切片素材目录>   # 也可写进 .env（不入库）
   npm run audio    # scripts/to-opus.sh：${AUDIO_ROOT}/已打标签 → 64k opus 进 static/audio/
   npm run data     # scripts/build_data.py：解析切片 → src/lib/data.json
   ```
3. **本地预览**：`npm run dev`；素材更新后重跑 `npm run data`，dev 会热更数据。
   直播间区块可选：`.env` 里配 `PUBLIC_LIVE_ROOM_ID=<B站房间号>`，不配则不渲染该区块。

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

- 两场录像（`2026-10-08 06-07-13`、`2026-10-09 15-35-02`）源文件残缺，`ffprobe` 时长 N/A，界面显示「无数据」。
- 「有音频无歌」片段不展示（录制导致，非开播）。

## 待办

- [x] 前端视觉重构（见 `docs/frontend-refactor-plan.md`，已完成于 `refactor/frontend` 分支）
- [ ] 合并 `refactor/frontend` 到 `main` 前重跑 Lighthouse 可访问性验收
