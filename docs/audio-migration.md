# 音频迁移：已有 HTTP 实例直接流式传到 S3

默认路径是 **HTTP → 有界内存流 → S3**，不先下载本地、不缓存整首音频。
目录清单来自 src/lib/data.json 的 recordings[].clips[].opus；此工作树缺音频不代表别处没有副本，也不能据此判断唯一权威源。

## 1. 本机迁移配置

使用当前 Node LTS（支持 fetch、--env-file），从仓库根运行。迁移在本机执行，不在 Vercel 请求中执行。
把以下变量放到仓库外、权限 0600 的 env 文件；不要提交、不要粘贴真实值到日志。

~~~dotenv
SOURCE_AUDIO_BASE=https://YOUR-SOURCE-HOST-HERE
AUDIO_S3_ENDPOINT=https://YOUR-S3-HOST-HERE
AUDIO_S3_REGION=YOUR-REGION-HERE
AUDIO_S3_BUCKET=YOUR-BUCKET-HERE
AUDIO_S3_ACCESS_KEY_ID=YOUR-ACCESS-KEY-HERE
AUDIO_S3_SECRET_ACCESS_KEY=YOUR-SECRET-KEY-HERE
AUDIO_S3_KEY_PREFIX=audio/
AUDIO_S3_PATH_STYLE=0
AUDIO_S3_URL_TTL_SECONDS=3600
~~~

占位符须替换为提供商配置；bucket/region 须满足其命名规则。endpoint 仅 origin，不带路径、查询、用户名。
SOURCE_AUDIO_BASE 与播放站点的 PUBLIC_AUDIO_BASE 独立，绝不自动回退到它。
默认请求 <SOURCE_AUDIO_BASE>/audio/<文件名>，兼容旧同源站点与采用 audio/ 前缀的 Blob。
如源站使用 S3 播放端点，加 --source-api 请求 <SOURCE_AUDIO_BASE>/api/audio-url?f=<编码文件名> 并跟随重定向。
base 可以带站点子路径；脚本自动补尾斜线。源必须支持 HEAD 并返回准确 Content-Length；缺失直接失败，不缓存文件来探长度。

~~~bash
node --env-file=/YOUR-ENV-FILE-HERE scripts/migrate-audio.mjs transfer --dry-run
node --env-file=/YOUR-ENV-FILE-HERE scripts/migrate-audio.mjs transfer --concurrency 4
~~~

--dry-run 验证配置、清单和源 HEAD，不 PUT；它不证明目标可写或内容完整。
--concurrency 接受 1–32，默认 4；--timeout-ms 为每对象整个操作期限，默认 120000，最大 3600000。
参数支持 --name=value 与 --name value；未知参数、路径穿越文件名在联网前拒绝。

## 2. 完整性、重跑与失败

默认只做大小检查：每对象 HEAD 源取得 Content-Length，再 HEAD 目标检查存在性及大小。
目标 key 已存在就跳过，不按大小决定重传，也不受 --overwrite 影响（不 GET 源或目标）。B2 同 key 上传会创建新版本，因此迁移只补缺失 key。
需要写入时只 GET 源一次，直接流式 PUT；检查传输字节数、OggS 魔数、PUT 成功和写后目标 HEAD 大小。默认完全不 GET 目标，不预下载源计算摘要。
**大小一致不是密码学完整性证明：同长度但内容不同的目标可能被跳过，传输中的同长度损坏也不能靠大小检查发现。** --overwrite 仅用于本地 pull 备份，不会让 S3 迁移重传已有 key。
兼容 Backblaze B2：不发送 If-None-Match 条件 PUT。覆盖保护依赖上传前 HEAD 检查，不是原子操作；HEAD 与 PUT 之间存在竞态。迁移期间必须保证没有其他进程向相同目标 key 写入，不要同时运行两份迁移；并发检查不是原子的，不提供互斥；迁移始终跳过已存在的目标 key。

需要完整校验时显式加 --verify-full：

~~~bash
node --env-file=/YOUR-ENV-FILE-HERE scripts/migrate-audio.mjs transfer --verify-full
~~~

此模式先完整流式读源计算 SHA256；目标同大小时完整 GET 并比摘要，一致才作为已验证对象跳过。
上传再次读源并比摘要，写后完整 GET 目标比 SHA256。目标损坏/不同只报错，不上传新版本，--overwrite 也不会改变此规则。
因此新对象通常读取源两遍、完整下载目标一遍；已存在同大小目标也要完整下载校验，会增加流量、请求及时间成本，使用前确认配额。默认模式不承担这些完整校验下载成本。
HEAD、ETag、长度一致不单独作为完整性证明；OggS 仅格式魔数检查，不是解码验证。
源需在迁移期间保持稳定；完整校验可检测摘要变化，默认模式不能检测同长度变化。

不写续传日志，不依赖本地状态；重跑按所选模式重新检查。中断不能按字节续传。
按文件粒度占用并发槽：一份文件完成下载→上传→所选检查后，该槽立即领取下一份；绝非整批下载完再整批上传。
流有 backpressure；内存随并发和流缓冲增长，不随音频文件大小增长。传输无音频临时文件。
失败会取消相关流；每对象有超时。429 报 Retry-After 提示并失败，无隐藏重试；按提供商要求等待后人工重跑。
迁移只读源，不删除旧对象。输出不含端点、签名或密钥，失败按清单对象序号定位。

## 3. 可选本地冷备

这不是默认迁移前置步骤。需要离线备份时才运行：

~~~bash
node --env-file=/YOUR-ENV-FILE-HERE scripts/migrate-audio.mjs pull --out /YOUR-BACKUP-DIR-HERE
node scripts/migrate-audio.mjs verify --out /YOUR-BACKUP-DIR-HERE
node --env-file=/YOUR-ENV-FILE-HERE scripts/migrate-audio.mjs push-s3 --out /YOUR-BACKUP-DIR-HERE
~~~

push-s3 默认大小检查，也可加 --verify-full。pull 保留完整摘要比较作为可选冷备流程；两者都使用流；pull 以 .part 临时文件落备份目录后改名。已有备份先做摘要比较，不同需 --overwrite。
verify 检查清单内文件可读及 OggS 魔数，不替代远端摘要比较，不报告清单外对象。

## 4. 切换、验收与回滚

1. 所有迁移对象通过所选检查（默认仅大小检查，非完整摘要验证）才进入切换；保留旧源及原部署 env。
2. 本机 env 不会自动传到 Vercel。Vercel 项目 Settings → Environment Variables 配置服务端 AUDIO_S3_*，PUBLIC_AUDIO_STORAGE=s3；清空不再使用的 PUBLIC_AUDIO_BASE，重新部署。自托管按其服务配置加载同样变量并重启。
3. 页面抽样播放、拖动 seek/Range、锁屏 MediaSession，检查请求确实到新目标且无 404；再选一个未缓存曲目。
4. 验证 /api/audio-url?f=... 跳转，非法路径被拒。该公开端点不是用户鉴权或防盗刷措施。
5. 有问题恢复旧 PUBLIC_AUDIO_STORAGE/PUBLIC_AUDIO_BASE 组合并重新部署。旧源始终未被迁移脚本修改；稳定性经人工确认后再单独决定是否下线，脚本不清理源。

## 测试

~~~bash
node scripts/test-migrate-audio.mjs
~~~

只用同进程本地 HTTP mock 和自动清理的临时目录，不使用真实凭据或外部写入。

## 存储能力开关

默认使用通用 HEAD → PUT，不发送条件头，兼容 B2。目标 key 已存在始终跳过；这是迁移策略，并非按提供商硬编码。

支持条件写入的 S3 服务可显式加 `--conditional-put`，对缺失 key 的 PUT 添加 `If-None-Match: *`，防止 HEAD 与 PUT 之间出现的并发创建。B2 不加此开关。条件写入返回 412 时本次对象报错，不自动改成无条件上传。

此能力开关独立于 `--verify-full`：前者控制条件写能力，后者控制是否读取全文做摘要校验。

## 实时日志

默认逐文件实时输出时间、清单序号和阶段（源检查、目标检查、上传、验证、跳过、完成）；错误立即写 stderr，不再等整批结束。末尾仍保留失败汇总。日志不输出签名 URL 或凭据，按序号对应清单。
