# 安允日记

音频是唯一业务实体：稳定 id、绝对 epoch 秒 startAt、独立时长和相对歌词。不存在录像父目录。时间轴、日视图、热力图、搜索、队列使用相同音频模型。

## 开发与验证

Node 22，按 package-lock.json 使用 `npm ci`。

```sh
npm run dev
npm test
npm run check
npm run build
DEPLOY_TARGET=vercel npm run build
DEPLOY_TARGET=capacitor npm run build
```

构建不发布数据、不访问对象存储。Capacitor 构建仅验证网页壳，不替代 Xcode 编译与真机后台/锁屏验收。保留原生睡眠定时器。

## 数据契约

上海时区每月 **7 日 00:00** 划分左闭右开业务月；跨界音频归开始所在月，不切割。`monthId` 是边界起始月的 YYYY-MM。manifest 保留全部历史月份及可用性；每月 JSON 包含该月音频与完整歌词，当前空月合法。

`MAX_QUERY_MONTHS` 在运行查询与发布保留共用：2 表示当前月和紧邻上月，空月也占位，不是最近两个非空月；0 表示不限。范围越界明确失败，不静默截断。滚动自然月日期短月 clamp，不额外加载第三个边界块。

同一 manifest/month/range/resolve 供应层使用修订缓存及请求去重。首页只启动当前月；历史按需加载。搜索走服务端逐月 NDJSON，关闭或更换查询真正取消请求，已完成结果可保留并显示 X/Y 进度。

## 同构后端

Vercel 与 MCSM/adapter-node 共用路由与业务逻辑，只替换 Blob/本地持久化适配器。配置占位模板见 `.env.example`，真实地址和凭据只能放仓库外的运行环境。未配置数据应显示错误，不回退旧全量 bundled 数据。

API：`GET /api/catalog` 返回 manifest，`GET /api/month/[id]` 返回完整月块，`GET /api/search?q=...` 流式搜索。音频 URL 直接对应持久化音频，月 JSON 清理不删除音频。

发布流程见 [数据发布](docs/data-publication.md)。旧全量目录、预签、迁移和桶配置路线已移除；历史只保留在 git。不要运行旧操作手册中的命令。

## 队列

队列持有音频独立快照与唯一 queueEntryId，同一个 audioId 可以重复出现。点击已存在音频定位，否则插在当前项后播放。日期生成只有在完整范围成功后才一次队首插入并播放；取消或失败不会修改队列。随机仅从当前队列抽取。恢复不依赖首页已加载月份，保持暂停和原生已有播放优先；搜索重排不改变队列。


## 项目与技术栈

SvelteKit 2（Svelte 5 runes）+ Vite 7 + Tailwind CSS 4 + lucide-svelte；支持 Web 与 Capacitor iOS 壳。数据由已打标签独立音频和同名 UTF-8 LRC 派生，不手填、不探查主录像。

- 三种视图：泳道时间轴 / 日卡片 / 热力图，共用 Audio 绝对时间模型。
- 内置播放器：点歌、上/下一首、进度、倍速、歌词、队列及睡眠定时器。
- 设计 token 位于 src/app.css，保留明暗主题与响应式布局；共享 Chip、Sheet、QueueOverlay、StateHint 位于 src/lib/components/。
- 配色选型页为 static/design-variants.html。历史视觉说明见 docs/frontend-refactor-plan.md，其中旧数据路线不再适用。

## 三视图与交互

- 泳道按绝对时间展示音频、点击即播；仅挂载当前活跃视图，其他视图动态导入，不在后台生成完整 DOM。
- 日卡按上海自然日聚合，不构造录音父实体。保留响应式卡片、日期、曲数徽标、展开/收起、当天替换列表、歌曲颜色点、序号、标题、时长及当前曲高亮。旧录像偏移改为绝对时间的上海时钟。每页最多 30 天，仅展开一天，歌曲每页最多 60 首。
- 热力图保留日期/星期列头、24 小时网格、明暗热度渐变、少/多图例、鼠标 tooltip、点击及 Enter/Space 装载当天列表。跨小时和自然日按实际占用秒数分摊；每页最多 31 天，统计不随分页改变。
- 热力范围独立于队列生成范围，保留日期输入、近 7/30 天、清除范围及本地记忆；只过滤已加载窗口，不隐式请求历史全量。统计保留活跃日、曲数、已知总时长、平均及五档分层。未知时长明确说明，不作为零秒参与平均。
- 日期面板完整范围成功后才生成并插入。分享 URL 使用 from/to 参数（上海时区、to 包含当天），仍受可用月份限制。
- 外部播放器导出、M3U 端点、VLC 直开和下载已移除，不恢复旧入口。

## 睡眠定时器

播放条月亮按钮提供预设分钟数、自定义分钟数及「播完当前曲目后停」，激活后显示倒计时并可取消。iOS 后台队列、系统媒体控制与睡眠由原生播放器持有；Web 模拟测试不代表锁屏/后台真机通过。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| src/app.css | 语义设计 token 与主题 |
| src/routes/+page.svelte | 月份窗口、三视图、面板懒加载 |
| src/lib/types.ts | Audio/Track 契约与格式化 |
| src/lib/supply.js、month.js | manifest/月供应、业务月与范围 |
| src/lib/player.svelte.ts | 队列、播放、恢复、睡眠 |
| src/lib/Player.svelte、Playlist.svelte | 播放条、日期生成 |
| src/lib/Timeline.svelte、DayStrip.svelte、Heatmap.svelte | 三视图 |
| src/lib/server/ | 同构后端及持久化适配 |
| scripts/ | 发布与合成夹具测试 |
| ios/ | Capacitor 壳和原生 AVPlayer |

音频、运行数据、真实配置和凭据不进入 git，不将旧 bundled 数据重新接为运行时输入。

## 部署到 Vercel / 自托管

1. Vercel 导入仓库，Framework Preset 选择 SvelteKit，根目录为仓库根。
2. Node 22.x，安装 npm ci、构建 npm run build，输出目录保持框架默认，不手填 build。
3. VERCEL=1 自动选择 adapter-vercel，或显式 DEPLOY_TARGET=vercel；本地/MCSM 默认 adapter-node，可显式 DEPLOY_TARGET=node。
4. 按 .env.example 配置持久化后端和查询月份上限；真实配置只放部署环境。可选 PUBLIC_LIVE_ROOM_ID 配置直播区块。
5. Vercel 产物为 .vercel/output/；adapter-node 由部署平台运行构建产物。音频路由需支持 Range，发布数据与应用构建分离。

本地 npm run dev；生产先 npm run build，再由已有服务管理器发布。端口、域名、隧道及具体 unit 属私有部署配置，不在此固化。不要照抄旧 RUNBOOK 的数据命令，不在测试时重启服务或发布真实存储。

## iOS App（Capacitor）

静态网页壳不携带服务端：先 DEPLOY_TARGET=capacitor npm run build，再 npx cap sync ios。

- 现代 iOS WebKit 可解码 Opus；原生 AVPlayer 接入与真机验收参考 [iOS 原生播放器验收](docs/ios-opus-test.md)，历史验收不等于本轮验证。
- 首次填写 HTTPS 后端基础地址，保存在 localStorage。App 使用后端 /api/catalog、/api/month/[id]、/api/search 与 /api/audio/ 路由，不请求静态壳自身的数据端点。后端设置可切换并重新加载。
- CapacitorHttp 接管 fetch 处理壳内跨域，媒体走原生播放桥。PUBLIC_AUDIO_BASE 可作默认后端；敏感值不写源码或构建产物。
- Web 与 App 共用校验后的 Audio/月目录与独立队列快照。加载错误明确显示，不回退旧全量目录。
- /api/live 是服务端代理，静态壳不能自行提供，直播区块保留兜底版式。
- 仍需 Xcode 编译和真机前后台、锁屏媒体控制、恢复与睡眠验收；静态构建或模拟测试不能替代。

## 已知限制与开发约定

- **跨平台注意**：runes 模块的导入必须写全后缀——`./player.svelte.ts`、`./theme.svelte.ts`（不是 `./player.svelte`）。
  `.svelte.ts` 后缀是 Svelte 5 模块级 runes（`$state/$derived`）必需的，不能改名；而裸写的 `./player.svelte`
  在 macOS 大小写不敏感盘上会先命中同名组件 `Player.svelte`，esbuild 依赖扫描直接报
  `No matching export`（2026-11-07 已把全部 13 处导入改为显式 `.ts`）。tsconfig 需配套
  `allowImportingTsExtensions: true`。
- 时长为空显示未知，不补查原始录像，不用歌词尾时间伪造时长。
- 月 JSON 可清理而音频独立持久化；已入队快照不依赖首页当前月份。
- 测试用合成夹具、模拟存储和原生桥桩，各套独立进程；不读取 NAS，不跑数据发布、转码、部署或服务重启。
- 可访问性与响应式视觉仍需人工验收，源码检查不等于 Lighthouse 或真机通过。

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

### 头像与 App 图标

唯一源文件为 `static/brand/avatar.png`，必须是 **1024×1024、无透明通道的 RGB PNG**。页面直接引用该文件；替换头像时保持文件名和格式。
`npm run build` 会先验证并直接复制该文件到 iOS AppIcon，不再维护 JPG 或单独转换图标。也可运行 `npm run icons` 立即同步。
