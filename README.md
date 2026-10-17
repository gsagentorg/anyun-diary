# 安允日记 · 直播歌单时间线

把 [主锚的直播间](https://live.bilibili.com/1732283852) 的每日录像，做成可浏览、可试听、可导出播放列表的歌单时间线。

- **数据零手填**：全部由**文件名时间戳 + 切片自带的元数据**自动生成，不人工录入。
- **三种视图**：泳道时间轴 / 日卡片 / 热力图。
- **内置播放器**：点击任意歌块即播，支持上/下一首、进度、**睡眠定时器**。
- **动态播放列表**：按 URL 时间范围或面板自定义范围生成，可**内置播放**，也可导出 **m3u 交给外部播放器（VLC/mpv）**。

> 注：“有音频但没识别出歌”的片段属录制导致，不代表开播，界面不展示。

## 技术栈

SvelteKit 2（Svelte 5 runes）+ Vite 7 + Tailwind CSS 4 + `lucide-svelte` 图标。
部署目标：**Vercel**（`@sveltejs/adapter-vercel`）。

## 前端重构（refactor/frontend 分支）

在 `refactor/frontend` 分支上完成的一次视觉/响应式重做，主分支不受影响。

- **设计 token**：单一来源在 `src/app.css` 的 `@theme`（语义字号 `--text-2xs/xs/sm/base/lg/xl`、圆角 `--radius-sm/md/lg`、`--color-*`），组件不再写任意值字号/圆角。
- **共享组件**（`src/lib/components/`）：`Chip.svelte`（胶囊徽标）、`HourAxis.svelte`（泳道/热力共用时间轴，按容器宽自适应 2h/3h/6h 刻度）、`Sheet.svelte`（播放列表面板，桌面右侧 / 窄屏底部抽屉）、`StateHint.svelte`（空列表/无数据/加载态）。
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
npm run data       # scripts/build.mjs → 解析录像名 + *-proj.llc + 切片元数据 → src/lib/data.json
npm run audio      # scripts/to-opus.sh → 切片转 64kbps opus 到 static/audio/
```

## 目录结构

```
src/
  app.css                     # Tailwind 主题（base-*/accent/warning）
  routes/
    +page.svelte              # 三视图切换 + 播放列表面板入口
    api/playlist/+server.ts   # 动态播放列表 m3u 端点（inline，交给系统播放器）
  lib/
    types.ts                  # 类型 + 纯工具（blocksOf/audioUrl/格式化/Track）
    playlist-core.ts          # 纯逻辑：按时间范围取曲、m3u 生成、日期解析
    player.svelte.ts          # 播放器内核：播放列表、上/下一首、睡眠定时器
    Player.svelte             # 底部播放条（含睡眠定时器菜单）
    Playlist.svelte           # 动态播放列表面板（范围选择 / 内置播放 / 外部播放 / 复制链接）
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
| 顶部「播放列表」 | 打开面板：自定义范围、应用并播放、外部播放、复制链接、下载 |
| 各视图「列表」按钮 | 时间轴 / 日卡片 / 热力图每行一个，一键把该场次全部曲目加入列表 |
| 外部播放 | `GET /api/playlist?from=&to=` 返回 `Content-Type: audio/x-mpegurl` + `inline`，浏览器注册了 m3u 处理器（VLC）时直接播放；另有「直开 VLC」（`vlc://`）与「复制链接」 |

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
2. **外部静态托管**：把音频放到任意可对公网提供 Range 的站点，设 `PUBLIC_AUDIO_BASE` 指向它（例如自建入口 `https://anyun-diary.public.bcw2.top:3004`）。
3. **随部署包**（不推荐，体积大）：删掉 `.vercelignore` 里的 `static/audio/` 且把它们加回 git。

> ⚠️ 注：音频已从 git **跟踪**中移除，但**历史提交里仍有**（本体 ~266MB）。彻底瘦身需重写历史 + 强推，属破坏性操作，**待确认后执行**。

## 部署到 Vercel

1. 导入仓库 `gsmainagent/anyun-diary`（框架自动识别 SvelteKit）。
2. 环境变量（可选，但强烈建议）：
   - `PUBLIC_AUDIO_BASE` = 托管音频的站点地址，例如自建公网入口 `https://anyun-diary.public.bcw2.top:3004`；留空则用同源 `/audio`。
3. 部署包默认**不含音频**（`.vercelignore` 排除 `static/audio/`，约 264MB）。音频走 `PUBLIC_AUDIO_BASE` 指向的静态托管；若确需随部署包走，删掉该忽略行（注意体积）。

构建产物：`.vercel/output/`（含 `functions/api/playlist` 服务端函数）。

## 本地常驻（可选）

本项目常驻三件套（systemd user 单元）：生产 node 服务、开发 vite dev、独立 frpc（**不触碰系统 frpc**）：

```bash
systemctl --user status anyun-diary-web.service    # 生产（adapter-node build，:4173）
systemctl --user status anyun-diary-dev.service    # 开发（vite dev，:5173）
systemctl --user status anyun-diary-frpc.service   # frpc（独立配置/凭据，不碰系统 frpc）
# 隧道：生产 anyun-diary.public.bcw2.top:3004 / 开发 anyun-diary-dev.public.bcw2.top:3004
```

> 注意：frpc 的 `serverAddr` 钉的是 `192.168.1.51`（LAN）。`cloud.bcw2.top` 在容器/公网 DNS
> 下会解析到另一台机器（115.195.46.106），那边的 frps 不被 nginx:3004 前置——注册“成功”也不会路由（曾导致整站 404）。

## 已知限制

- 两场录像（`2026-10-08 06-07-13`、`2026-10-09 15-35-02`）源文件残缺，`ffprobe` 时长 N/A，界面显示「无数据」。
- 「有音频无歌」片段不展示（录制导致，非开播）。

## 待办

- [x] 前端视觉重构（见 `docs/frontend-refactor-plan.md`，已完成于 `refactor/frontend` 分支）
- [ ] 合并 `refactor/frontend` 到 `main` 前重跑 Lighthouse 可访问性验收
