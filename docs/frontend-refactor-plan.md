# 前端美化重构计划（已准备，**尚未执行**）

> 状态：**计划就绪、暂不执行**。执行前请先确认目标风格（参考站/配色/是否要深浅色切换）。
> 原则：**不改数据管线、不改 URL 约定、不破坏现有播放列表与睡眠定时器行为**。

## 1. 目标

1. 视觉统一：目前三种视图各写一份样式，徽标/间距/圆角/字号不一致。
2. 信息层次：每行「谁/何时/多长/几首」的层级更清晰，扫读更快。
3. 交互一致：点击、悬停提示、选中态、空状态、加载态在所有视图表现一致。
4. 移动端可用：当前泳道/热力图最小宽 860px，手机上只能横向滚。
5. 为后续增量留缝：设计 token + 通用组件，后续加视图不用复制粘贴。

## 2. 现状痛点（证据）

- 样式硬编码散落：`Timeline.svelte` 中 `text-[10px] opacity-60`、`Heatmap.svelte` 中 `text-xs`、`DayStrip.svelte` 中 `text-[11px]` —— 同类信息三种规格。
- 色值来源不统一：`hueOf()` 生成随机色相 + `bg-accent` 混用，图例与块颜色无体系。
- 空/异常态各写各的：`无数据` 文案在 3 个文件重复。
- 无骨架屏：`player.loading` 只覆盖播放条，页面首屏无占位。
- 无键盘导航：泳道/热力图块是 `role="button"`，但 Tab 顺序与提示不完整。
- 间距无标尺：`px-4 py-8 / mb-2 / mt-3` 混用，无统一 spacing scale。

## 3. 设计系统（建议）

**Tokens（写入 `src/app.css` 的 `@theme`）**

| 类别 | 建议 |
| --- | --- |
| 颜色 | `--color-base-100/200/300`（暗色底）、`--color-accent`、`--color-warning`、新增 `--color-song`/`--color-zzz`/`--color-grid` 语义色 |
| 字号 | `text-2xs`(10px)/`xs`(11px)/`sm`(13px)/`base`(15px) 四档，去掉任意值 |
| 间距 | 4 的倍数标尺：`gap-1/2/3/4/6`，禁止 `px-1.5` 类半值（保留 1.5 仅限图标内边距） |
| 圆角 | `rounded-md`(块) / `rounded-lg`(卡片) / `rounded-full`(胶囊) |
| 阴影 | 仅浮层用 `shadow-lg`；页面元素用边框区分层级 |
| 动效 | 统一 `transition` 150ms ease-out；悬停缩放仅用于可点击块 |

**主题**：默认暗色；预留 `data-theme="light"` 变量覆盖（Tailwind v4 用 CSS 变量天然好做）。是否做浅色**待确认**。

## 4. 组件化清单

| 新组件 | 替代 | 说明 |
| --- | --- | --- |
| `Chip.svelte` | 各处 `rounded-full bg-*/px-2 py-0.5` | `variant=accent/neutral/warning`，`size=sm/xs` |
| `IconButton.svelte` | 播放条/视图内按钮 | 统一 9×9 点击区、`aria-label` 必填、禁用态统一 30% |
| `RowLabel.svelte` | 三视图左侧标签列 | 统一「日期 / 开播 / N 歌 · 总时长 / 列表按钮」结构 |
| `SongBlock.svelte` | 泳道块 + 热力块 | 抽出点击/键盘/提示逻辑，色相走 `hueOf` 但套统一明度/饱和 |
| `Tooltip.svelte` | 三处手写 `tip` 定位 | 统一跟随光标、边界翻转、`role="tooltip"` |
| `StateHint.svelte` | `无数据`/空列表文案 | `kind=empty/no-data/loading` 三态 |
| `Sheet.svelte` | 播放列表面板 | 桌面右抽屉 / 移动端底部 Sheet |
| `Skeleton.svelte` | 无 | 首屏与切换视图时占位 |

## 5. 布局与响应式

- 统一页面 shell：`header`（标题 + 视图切换 + 播放列表入口）+ `main`（视图）+ 固定 `Player`。
- 断点：`<768px` 泳道/热力图切「单行概览卡 + 点击展开」，取消 860px 强制横向滚动。
- 播放条：窄屏隐藏次要信息（录像名），保留歌名/进度/上下一首/睡眠。
- 播放列表面板：桌面右抽屉（`w-96`），移动端底部 Sheet（最大 70vh）。

## 6. 交互与无障碍

- 所有可点块：`Tab` 可达、`Enter/Space` 触发、`focus-visible:ring-2`。
- 视图切换用 `role="tablist"`；播放列表项 `aria-current`。
- 提示层 `aria-describedby` 关联；动态区域（加载/睡眠触发）用 `aria-live="polite"`。
- 尊重 `prefers-reduced-motion`：关闭缩放/过渡。

## 7. 性能

- `data.json` 已 ~155 曲规模，暂不虚拟列表；若 >500 再引入。
- 首屏只算可见视图的 `blocksOf()`（当前三视图全部计算），加 `$derived` 惰性。
- 音频保持按需加载（现状已是 `preload=metadata`）。

## 8. 分阶段 PR（每步可独立验收）

1. **P1 Tokens + 主题变量**：只加 `app.css` 变量与语义色，不动结构。
2. **P2 Chip/IconButton/StateHint**：替换重复样式，肉眼无变化但代码收敛。
3. **P3 RowLabel + SongBlock + Tooltip**：三视图共用行结构，视觉打磨。
4. **P4 响应式 + Sheet**：移动端布局与播放列表面板形态。
5. **P5 骨架屏 + 无障碍 + 动效收敛**。
6. **P6 浅色主题（若确认要做）**。

## 9. 验收标准

- [ ] `npm run check` 0 错误；`node --test`/单测全绿。
- [ ] CDP 冒烟：三视图渲染、点击播放、`?from&to` 装载、睡眠定时器倒计时、m3u 端点 200。
- [ ] 320px / 768px / 1280px 三档截图无溢出、无遮挡（播放条不盖内容）。
- [ ] 现有 URL 参数与外部播放链接行为**不变**。
- [ ] Lighthouse：可访问性 ≥95、性能 ≥90（移动）。

## 10. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 大改样式误伤功能 | 每阶段独立 PR + CDP 冒烟；功能逻辑不动 |
| Tailwind v4 token 迁移遗漏 | P1 先并存旧类，P2 才清理 |
| 移动端重排影响泳道语义 | 先做「概览卡→展开」而非重画泳道 |
| 视觉回归无基线 | 改造前先截三档图存 `docs/screenshots/before/` |

> 执行前需 owner 确认：**目标风格参考**、**是否做浅色主题**、**移动端优先级**、**是否接受分 6 个 PR**。
