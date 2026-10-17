# 前端彻底重构计划 v2（2026-10-17 重排）

> 状态：**执行中**。分支 `refactor/frontend`；开发实例（anyun-diary-dev.public.bcw2.top:3004）指向分支 worktree，生产（anyun-diary.public.bcw2.top:3004）锁 main。
> 原则不变：不改数据管线、不改 URL 约定、不动音频托管（同源 /audio）。

## 0. 为什么推翻重做（现状证据）

- **挤**：容器 max-w-6xl(1152px) + 泳道 min-w-[860px] + 左标签列 w-44(176px) + 行高 32px / 歌块 20px / 小时标签 10px——1440 屏上每条泳道仅 ~700px，24 个刻度、几十个歌块糊在一起；改参数治标不治本。
- **三套视图各自为政**：Timeline/DayStrip/Heatmap 各写一套样式与 tooltip；字号 9/10/11/12/xs 混用无标尺。
- **无响应式**：窄于 860px 只能横向滚；手机不可用。
- **播放条堆功能**：播放/上一首/计数/下一首/随机/睡眠/关闭，小屏溢出、图标语义弱。
- **状态不统一**：空列表、加载、无数据各写各的。
- 样式硬编码在组件里，没有 token 层，任何全局调整都是全库 sed。

## 1. 目标（可验收）

1. 1440px 屏一屏看全当天泳道且不挤；1280px 可用；768px 平板可读；手机(<640px)有专门布局。
2. 设计 token 单一来源（`src/app.css @theme`），消灭任意值字号/间距。
3. 共享组件覆盖 ≥80% UI 片段；三视图只留各自的"布局逻辑"。
4. 键盘可达（Tab 顺序合理、Enter/Space 触发、focus-visible 明显）。
5. Lighthouse 可访问性 ≥95。

## 2. 设计系统（tokens）

| 类别 | 方案 |
| --- | --- |
| 色彩 | base-100/200/300 三级底色 + accent(主行动) + accent-muted(hover) + warning(睡眠/估算) + song/heatmap 语义色；hueOf 保留但饱和度统一 65%、亮度分 3 档表示时长分位 |
| 字号 | 2xs(10) / xs(11) / sm(12) / base(14) / lg(16) / xl(20)，全部语义 token |
| 间距 | 4px 栅格：gap-1(4) gap-2(8) gap-3(12) gap-4(16) gap-6(24)；禁止任意值 |
| 圆角 | sm(2,色块) md(6,输入) lg(10,卡片) full(胶囊) |
| 高度 | 行高 40px（泳道）/ 36px（热力行）/ 56px（播放条）/ 44px（按钮点击区） |
| 动效 | 150ms ease-out；仅可交互元素 hover 反馈；prefers-reduced-motion 关闭 |

## 3. 布局（解决"挤"的核心）

- **壳**：`max-w-[1600px] mx-auto px-4/6/8(随断点)`；顶栏 sticky（标题+视图切换+播放列表入口+当前播放迷你信息）。
- **泳道视图**：
  - 左标签列压缩为 **96px 紧凑卡**（日期两行：MM/DD + 周几+场次徽标），或 hover 浮层展示详情（歌数/总时长/列表按钮挪进浮层与右键菜单）。
  - 泳道占满剩余宽度，行高 40px、歌块 20px、圆角 sm。
  - 刻度自适应：容器宽 ≥1200px 每 2h 标签、800-1200 每 3h、<800 每 6h；半小时细线保留。
  - 空隙（原 zzz 区）不画任何东西，靠底色对比。
- **热力图**：日列 × 24 行矩阵保留，格子 14px、圆角 sm、gap 3px；列头日期斜排或双行；图例横排底部。
- **日卡片**：单列宽卡（移动友好），歌单内嵌展开；徽标统一 Chip。
- **播放列表面板**：右侧 Sheet（w-96，桌面）/ 底部抽屉（<768px）；含范围选择、格式选择、列表、当前项高亮。
- **播放条**：左侧歌名+副信息（来源/偏移）、中间进度（可拖）、右侧控制组（上一首/播放/下一首 + 更多菜单收纳随机/睡眠/关闭）；>1024px 全展开，更窄收进菜单。

## 4. 组件清单（src/lib/components/）

| 组件 | 替代 |
| --- | --- |
| `Chip.svelte` | 各处胶囊徽标 |
| `IconButton.svelte` | 播放条/视图内按钮（统一 44px 热区、aria-label 必填） |
| `Tooltip.svelte` | 三份手写 tip（统一跟随+边界翻转+aria） |
| `Sheet.svelte` | 播放列表面板（右侧/底部双形态） |
| `Lane.svelte` + `SongBlock.svelte` | 泳道行与歌块（含键盘/悬停/激活态） |
| `HourAxis.svelte` | 泳道/热力共用的时间轴刻度（自适应密度） |
| `HeatGrid.svelte` | 热力矩阵 |
| `StateHint.svelte` | 无数据/空列表/加载中 |
| `Skeleton.svelte` | 首屏与切换占位 |

## 5. 交互与无障碍

- 所有可点：role/tabindex/keydown + focus-visible:ring-2 ring-accent。
- 视图切换 `role="tablist"`；面板 `aria-expanded`；播放状态 `aria-live="polite"`。
- Tooltip 挂 `aria-describedby`。
- 媒体浮层（Media Session）保持，标题/专辑信息沿用。

## 6. 性能

- `lanes`/`cells` 派生已惰性（$derived）；>500 曲再考虑虚拟滚动。
- 音频保持 preload=metadata。
- 构建产物检查：首屏 JS < 200KB gz。

## 7. 分阶段（每阶段独立 PR-equivalent commit，CDP 截图对比后推进）

- **P0 基线**：3 断点(390/768/1440) × 3 视图截图存 `docs/screenshots/before/`。
- **P1 tokens**：app.css 重写 @theme；旧任意值类暂并存。
- **P2 壳与响应式**：新布局壳 + 顶栏 + 断点行为（这一步直接缓解"挤"）。
- **P3 视图重构**：HourAxis/Lane/SongBlock/HeatGrid 上线，三视图换新皮。
- **P4 播放器**：新播放条 + Sheet 化播放列表面板。
- **P5 细节**：Tooltip/StateHint/Skeleton/键盘/空态。
- **P6 收尾**：全库清任意值类、Lighthouse、README 更新、验收清单勾完。

每阶段完成即推分支 + 截图存 `docs/screenshots/after-P{n}/`，owner 过目后进下一阶段。

## 8. 验收

- [ ] 1440/1280/768/390 四档截图无溢出、无遮挡（播放条不盖内容）
- [ ] 泳道在 1440 下单屏可读，小时标签不重叠
- [ ] `npm run check` 0 错误；单测（playlist/shuffle）全绿
- [ ] URL 参数播放列表、外部播放格式、睡眠定时器、随机、Media Session 行为全部不回退
- [ ] Lighthouse a11y ≥95
- [ ] git 全程在 refactor/frontend；merge 前生产不受影响

## 9. 工作流与回滚

- `~/anyun-diary`(main) → 生产构建源；`~/anyun-diary-refactor`(worktree@refactor/frontend) → dev 实例。
- dev systemd 单元指向 worktree；改坏了只影响 dev URL。
- 主线发现问题照常修 main（hotfix），分支 rebase 跟进。
- 放弃重构：删 worktree + 分支即可，生产零影响。
