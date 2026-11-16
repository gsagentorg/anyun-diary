# 音频月块发布

发布与前端构建解耦，输入仅是只读的已打标签切片音频及同 stem UTF-8 LRC。不得探查主录像、回填历史骨架或写源目录。

```sh
npm run data:publish -- --audio-dir YOUR-AUDIO-DIRECTORY-HERE --lrc-dir YOUR-LRC-DIRECTORY-HERE
```

发布是外部写入，真实执行须 owner 另行明确授权；本轮开发只验证 mock。环境配置与 CLI 支持以脚本 `--help` 为准。

- 音频 startAt = 文件名旧时间基准 + offsetStart；歌词时间相对音频起点，稳定 id 不随标题变化。
- 上海每月 7 日 00:00 分块，跨界音频不切割。当前无音频也发布空月。
- manifest 保留全部历史条目；只有变化的月 JSON 与 manifest 被更新。
- 先写新/变月块，再更新 manifest，最后清理超限月 JSON。音频永不随月 JSON 清理。
- `MAX_QUERY_MONTHS` 发布与查询共用，2 为当前及紧邻上月（空月计入），0 不限。
- 构建不访问存储；Vercel / adapter-node 仅持久化适配器不同。

不会部署、重启服务、修改生产配置或存储桶策略。无旧数据双栈回退。
