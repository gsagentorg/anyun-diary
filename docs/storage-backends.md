# 同构持久化

运行时只有 local 和 Blob 两个持久化适配器，业务路由相同。没有全量目录、预签或桶配置接口，也不引入 Algolia。

manifest 是轻量历史目录，每月 JSON 带完整歌词。音频按稳定路径持久化，不因月 JSON 保留策略删除。

`MAX_QUERY_MONTHS=2` 约束当前及上月（含空月）；0 不限。发布清理和运行查询共享该契约。

本地数据目录在仓库外，通过环境配置。Blob 私密配置只在服务端和发布进程中使用。开发测试必须注入 mock 适配器，不访问真实服务。

## Blob 缓存限制（SDK/官方文档核验）

Vercel 官方 `using-blob-sdk` 文档明确 `cacheControlMaxAge` 最小为 1 分钟，
不可设 0。当前 manifest 使用 60 秒，内容寻址的月块/音频使用 31536000 秒；
运行请求 `cache: no-store` 不等于绕过服务端 CDN，更新存在缓存可见性延迟。
写后读取校验失败必须中止，不清理旧块；不得据此自动重试不确定写。
核验来源：https://vercel.com/docs/vercel-blob/using-blob-sdk 。
本地安装 SDK 的 put 参数构造器只转换 header，不校验该服务端下限，
故 mock 与本地 SDK 参数接受不能替代官方约束。未访问真实 Blob。
