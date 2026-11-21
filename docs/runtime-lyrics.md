# 原生歌词：运行时队列快照，不绑定构建数据

## 数据契约

`NativeLyrics.hydrate(items)` 保留原生播放的单参数调用方式。恢复和配置队列只使用**每一个 item 自己持久化的运行时歌词**，不读 Bundle、源码数据、其他队列条目、网络或当前网站目录：

1. 非空的顶层 `item.lyrics` 优先，原样保留，不用更新版本的目录覆盖。
2. 顶层缺失、null、非数组或空时，只有本条目的 `item.audio.lyrics` 是有效非空快照才补到顶层。有效快照要求时间为有限数值（不是布尔值）、按时间非递减排列，文字为字符串；重复时间合法。
3. 顶层与 audio 同为空时保持空；两处都缺失时保持缺失；无效 audio 快照也不编造替代值。
4. 不按 ID、歌名、文件名、日期推断或跨条目补配。相同 ID 的多个队列项仍独立，顺序和其他元数据不变。

现有 `queueJSON` 已持久化完整队列及歌词，关闭应用再恢复不需要重载网站。对真正没有歌词快照的遗留记录，无法从本条目恢复的数据就继续缺失：不会混入另一个发布版本的歌词。重新选择曲目可以产生新的运行时快照，但不是旧队列恢复的前置条件。

选行规则未改：最新的有效时间戳、同刻组首行；超出有效 duration 的尾部行折叠到结束时刻，结束时刻同组仍取首行。无有效 duration 时按源时间，seek 回退照常重新二分。

## 旧构建入口

`scripts/sync-native-lyrics.mjs` 仅为旧调用兼容保留。它只 `unlink` 确切的旧生成物 `static/native-lyrics.json`；不存在则正常退出。没有读目录数据、联网或写入运行数据，也不会删除整个目录。若该路径意外成为目录，会失败并保留内容；若为软链，只删除该软链。

因此旧 prebuild 调用无需取得目录数据即可执行，且后续构建不会因这个入口生成全站静态歌词表。已有构建目录是旧产物；验收应运行正常的新构建并确认产物中没有 `native-lyrics.json`，不要把之前 build 留下的文件当作新产物。

## 验证入口

```sh
node scripts/test-runtime-lyrics.mjs
# macOS 发布门禁：不允许跳过 Swift
node scripts/test-runtime-lyrics.mjs --require-swift
```

此入口只在系统临时目录生成合成测试数据，不读取真实 `data.json`、音频或设备偏好：

- 所有主机执行清理行为与源码依赖检查：准确删除、幂等、无 data 依赖、与 cwd 无关、保留邻居文件、软链不跟随、目录拒绝删除。
- macOS 用 `xcrun --find swiftc` 编译真实 `NativeLyrics.swift` 加 `scripts/test-native-lyrics.swift` 中的合成可执行测试，实际断言选行、重复时间组、duration 边界、无效时长、seek、同项恢复、重复 ID 隔离、显式空、缺失、不变性、幂等以及合成 queueJSON 往返。编译或测试失败不自动重试。
- Linux 明确输出 `SKIP`，不冒充 Swift 已执行；加 `--require-swift` 必须退出失败。源码检查不是 Swift 执行。
- 该测试不等于 Xcode App target 编译或 iPhone 锁屏/后台真机验收；后两项须单独执行。

`scripts/test-native-lyrics.swift` 已替换为运行时合成 fixture，由上述 Node 入口读取、编译并执行；不再注入构建 catalog，也不读取真实数据或设备偏好。
