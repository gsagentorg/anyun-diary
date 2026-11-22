# 睡眠曲线参数编辑器

## 状态与使用

保留全部既有预设，新增「自定义参数」。四组有 label 的 range + number 原生控件支持键盘、触控和数值输入；无效/空输入不进入计划，失焦回到有效值。恢复默认为 holdPercent=30、endDb=-24、exponent=2、tailPercent=10。

选择方式、编辑参数、恢复默认只修改下次启动计划。启动复制四个参数到 sleep.activeCustom；运行主曲线、移动 marker、音量、时间轴拖动始终使用此快照。编辑器另有下次计划实时 SVG，并明确标示不会改变当前运行。重新开始才取新快照。取消、到期、本曲后停止、暂停和中断恢复沿用既有流程。

Web 只恢复下次计划，不恢复关闭页面的倒计时。原生恢复运行墙钟截止时间、快照及 revision，默认暂停加载，不需要后台 JavaScript。

## 公式（TS / Swift 同义）

令 t=clamp(progress,0,1)，非有限 progress 视为 0；t>=1 增益为 0（off 预设沿用旧语义，截止时间负责暂停）。

- h=holdPercent/100
- r=min(tailPercent/100,(1-h)/2)
- f=1-h-r，至少为总时间的 5%，确保合理非零 dB 下降窗口
- u=clamp((t-h)/f,0,1)
- base=10^(endDb * u^exponent / 20)
- smooth(x)=x²(3-2x)
- 有尾段且 t>1-r 时 gain=base*(1-smooth((t-(1-r))/r))；其他时间 gain=base

保持段恒为 1，dB 下降归一化到剩余的非保持非尾部窗口，尾部从指定 dB 平滑到真零。tailPercent=0 不使用尾部，到截止前保持 dB 终点然后切断。例如保持 90%、请求尾段 30%，实际为保持 90%、dB 下降 5%、归零 5%。不挤入保持段或生成负窗口，UI 显示实际比例。

范围：hold [0,90]、endDb [-60,0]、exponent [.25,4]、tail [0,30]；范围内连续值均支持，控件步长分别 1/1/.05/1。增益单调且有界 [0,1]。

WebAudio 301 点 automation、兼容 volume、SVG path/marker 共用 sleepGain。WebAudio 在样点之间由系统插值，不声称任意瞬间与连续公式逐位相等。

## 存储及桥接

- 下次方式沿用 anyun-sleep-preset-v1。
- anyun-sleep-custom-v1 保存 {version:1,parameters:{holdPercent,endDb,exponent,tailPercent}}。
- 四参数严格原子校验，只接受有限 number，不接受字符串、布尔、缺字段或越界。损坏 JSON、未知版本或任一坏字段全体安全回默认，不拼凑半份参数。编辑 API 对坏修改保持上次有效计划。localStorage 拒绝时内存仍可用。
- NativeConfig/State 增加可选 sleepCustom、sleepCustomVersion，configure 发运行快照而非编辑计划。NativeSleep 仅接受新 sleepRevision 替换运行参数；同 revision 队列/设置同步不改变运行曲线，不重启已完成计时。
- NativePlayback snapshot / UserDefaults 保存快照、版本、revision；恢复走同样校验，坏参数回默认 custom，绝不隐式换 gentle。
- State 可选 supportsCustomSleep，新壳 true；缺失/false/握手未确认时禁用 custom 启动并诚实提示更新。原预设、本曲后仍可用。startSleep 和 NativeAudio 发送端都有防线，不会绕过 disabled 把 custom 传给旧壳。

## 验证命令（已接 package 与总测试入口）

    node_modules/.bin/vite-node scripts/test-sleep.mjs
    node_modules/.bin/vite-node scripts/test-sleep-custom.mjs
    node_modules/.bin/vite-node scripts/test-native-audio.mjs
    node scripts/test-native-sleep.mjs
    node scripts/test-native-sleep.mjs --require-swift
    npm run check

custom 行为测试涵盖 81 组参数密集网格、单调有界、保持/尾部边界、重叠/零尾、坏值/版本、序列化、输入拷贝、preview-vs-run、重新开始、拖动、暂停/恢复、先停后恢复音量、旧壳拒绝与兼容 volume。NativeAudio mock 验旧壳拒绝/预设正常、custom 配置、compact delta、冷 adapter 从 native snapshot 恢复。

可选实际 Chromium 编辑器 + 实际 player-state 隔离 harness，不读取真实目录/音频，不触发应用构建：

    PLAYWRIGHT_MODULE=YOUR-PLAYWRIGHT-MODULE-HERE CHROMIUM_PATH=YOUR-CHROMIUM-EXECUTABLE-HERE node_modules/.bin/vite-node scripts/test-sleep-custom.mjs --browser

Swift runner 用实际 TS 生成约 9 万个预设/custom 网格和边界 fixtures，再编译实际 NativeSleep.swift + test-native-sleep.swift 比较，不是 JS 重写 Swift。另验 revision、cancel、deadline、after-track、序列化恢复、坏数据及版本。无 swiftc 明确 SKIP；--require-swift 必须 exit 1。用 macOS xcrun 或 PATH 上已有 swiftc，不安装工具链。

## 未验边界与原生门禁

Linux source contracts / Web check 不等于 Swift 编译。Mac 必须跑 --require-swift，再 Xcode 编译完整 App target（含 Capacitor / AVFoundation；Foundation-only parity 不覆盖它）。iPhone 验前后台/锁屏、音频中断、冷启动恢复、到期暂停、取消恢复音量及拖动。旧安装壳 + 新 Web 必须显示 unsupported 而非 gentle；新壳支持四参数。本任务不运行共享 production build，不改配置/依赖/数据/音频/部署。

## Parent integration acceptance

Parent independently reran check (0 errors / 0 warnings), sleep 168, custom 232644 assertions, real Chromium isolated editor/player harness, native-audio including capability and snapshot restoration, session, player-ops 26 and native-offline 119 source contracts. A fresh Node application build passed; the production Chromium feature harness now includes the actual Player editor flow and passed 9/9. It proves four controls, a changed preview without changing the running curve, restore-default isolation, restart applying the new plan and uninterrupted playback. Browser mocks/Chromium do not establish Swift or iPhone correctness. Old dangling upload package entries were explained to the owner and left unchanged pending their decision.
