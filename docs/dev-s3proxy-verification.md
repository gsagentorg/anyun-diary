# S3Proxy dev 验收（2026-11-18）

仅现有 anyun-diary-dev，非生产部署。原 local 数据未删除；代码工作树与既有修改保留，无 commit/push/main 合并。

## 实际数据链

- owner 指定 S3Proxy 镜像，linux/amd64；podman create + systemd user unit start -a。
- filesystem 权威位置 `~/.local/share/anyun-s3proxy-dev/data`。不再使用早期 Deploys 临时副本。
- 旧 AUDIO_S3_* 配置与 S3_PREFIX 分离：587 个 hash 音频位于 objects，数据目录位于独立 catalog-dev；真实发布器复用已存在 hash 对象，音频写入 0 次。
- 输入为前序权威音频/LRC 派生且已准备的 local month-store，只读复用，不重新编码。3个月：108、361、118；587/587 带歌词。
- current→release→month 实际读取，真实发布器验证所有音频内容摘要；真实 SDK 回滚/再切回，最终回到完整权威版本。

## 已验收

- 587/587 HTTPS signed GET Range 206；未签名403，篡改签名403；OPTIONS200，CORS限定dev origin。
- 浏览器实际解码、播放、暂停、seek20秒；对象端点响应2次，应用音频字节0。
- TTL10秒：暂停11秒后重新播放续签、再暂停11秒后seek45秒续签；解析3次，暂停意图/rate1.25/volume0.3保留，错误0。正常配置已恢复900秒。
- 浏览器热更：真实新release，month503注入保留旧状态；恢复后成功原子切新；最终恢复权威release。
- MAX_QUERY_MONTHS=2时旧月404，搜索只完成2月；已恢复dev=0。最终3月全可用、587条。

## 未解决边界

- 越界Range实际416但缺Content-Range（null）；未获补丁授权，未加网关workaround。正常Range/播放/seek不受本次观察影响，不代表全部媒体客户端兼容。
- TTL<=5秒与客户端5秒提前续签窗口冲突：TTL3秒实测重复解析322次；未修代码。正常900秒与TTL10秒验证通过。
- 浏览器故障注入仅month503；iOS、生产、runner不在范围。

## 操作/回滚

真实URL、身份、CORS origin唯一引用 `~/.config/credentials/anyun-s3proxy-dev.env`（0600）。对象隧道配置 `~/.config/credentials/anyun-s3proxy-dev-frpc.toml`（0600），FRP令牌仍引用全局权威文件。现有应用drop-in使用EnvironmentFile读取，无凭据入库。

停对象服务：`systemctl --user stop anyun-s3proxy-dev-frpc anyun-s3proxy-dev`；保留数据。

回退local：将 `~/.local/share/anyun-s3proxy-dev/config-before/storage.conf` 恢复至现有dev的storage.conf drop-in，daemon-reload并restart anyun-diary-dev；原local数据不变。

重建前先核数据及挂载存在，再停unit/cleanup旧容器；指定镜像与权威env-file、当前数据挂载执行podman create，之后unit start；不使用run -d。完整登记见workspace DEPLOYMENTS.md §6。

证据在 `~/.local/share/anyun-s3proxy-dev/` 的 publication/api/object/browser/renewal/release/permission-report.json。
