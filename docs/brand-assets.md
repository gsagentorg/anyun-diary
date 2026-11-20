# 品牌图：运行时抓取，不进构建产物

头像与直播间封面属于**运行时数据**，不属于源码或静态资源。构建产物里不再包含任何品牌图；页面在运行时按基址拼 URL 取图。

## 源文件与目录

- 原生 App（Capacitor 静态壳）里 `/brand/` 同源路由不存在：品牌图跟随用户配置的数据后端基址（`<backend>/brand/`），未配置后端时显示占位，不影响其余功能。

- 源文件在 `assets/brand/avatar.png`、`assets/brand/cover.jpg`（git 跟踪，只是发布输入）。
  - `avatar.png` 必须是 **1024×1024、无透明通道的 RGB PNG**（同时是 iOS AppIcon 的源，`npm run icons` / `prebuild` 会校验并复制）。
- `static/` 下没有任何品牌图；`npm run build` 的产物（`build/client`、`cap/`）里也不会有。
- `static/design-variants.html` 是开发用的配色选型文档页，不是品牌资产，保持原样、不参与品牌图发布。

## 基址解析（优先级从高到低）

1. `PUBLIC_BRAND_BASE`（`$env/dynamic/public`）：绝对 `http(s)` URL 或同源路径（如 `/assets/brand`）。指向公开 CDN / 对象存储公开域名时用它。
2. 数据后端基址同源：`<数据后端基址>/brand/`。Web 端数据后端即页面同源，原生 App 用用户已配置的后端，品牌图跟着走同一源。
3. 同源 `/brand/` 兜底。

非法值（协议相对 `//host`、相对路径、查询串/hash、URL 内嵌凭据、非 http(s)）一律视为未设置，向后回落，不抛错。实现在 `src/lib/brand.ts`（纯函数，单测覆盖），运行时取值在 `src/lib/brand-runtime.ts`。

## 同源端点与存储

- `GET /brand/<file>`：文件名白名单 `avatar.png` / `cover.jpg`，由 `src/lib/server/brand.mjs` 按当前存储适配器（local / blob / s3）读取 `brand/<file>` 键，回 `content-type` + `content-length` + `etag`，`cache-control: public, max-age=600, must-revalidate`。
- 存储白名单 `validKey` 只放行这两个键；其余 `brand/*` 仍是非法键。
- 浏览器拿到的永远是应用同源 URL（或 `PUBLIC_BRAND_BASE`），**不拿存储地址、签名或凭据**。dev 的对象服务只允许签名读，因此品牌图由服务端读字节回传；生产若允许匿名直读/CDN，把 `PUBLIC_BRAND_BASE` 指过去即可，不需要改代码。

## `crossorigin` 与 CORS

`<img>` **不带** `crossorigin`：品牌图纯展示，没有 canvas 像素读取、没有 `preload`/`decode` 的 CORS 需求。跨域取图在不带 `crossorigin` 时只需常规图片请求权限（无 CORS 头也能显示），因此不必为品牌图给存储/CDN 开 CORS。

**将来若要从图片读像素**（`canvas.drawImage` + `getImageData`、`createImageBitmap` + 导出、WebGL 贴图取样等），浏览器会按 CORS 校验：届时必须由品牌源返回 `Access-Control-Allow-Origin`（且 `<img>` 加 `crossorigin`），否则画布被污染、读取抛错。这是源站/存储侧配置，不是本仓库能代劳的，届时再单独评估。

## 发布

```bash
# 默认读 assets/brand/，写入当前环境配置的存储（CATALOG_STORAGE=local|blob|s3）
npm run brand:publish
# 指定其他目录
npm run brand:publish -- --dir /path/to/brand
```

- 键固定为 `brand/avatar.png`、`brand/cover.jpg`；S3 下即 `<S3_PREFIX>/brand/...`，dev 环境（S3_PREFIX 为空）落在桶根 `brand/` 前缀。
- 与数据发布同一纪律：先校验 PNG/JPEG 文件头，只写内容变化的键，**写后复读摘要校验**，不一致即中止、不自动重试。
- ACL/可见性沿用现有对象口径（不额外设 per-object ACL；公开与否由桶策略/CDN 决定）。**浏览器不直连对象端点**，所以 dev 不需要为品牌图放开匿名读。

## 加载失败降级

`src/lib/components/BrandImage.svelte`：失败后附 `?retry=1` 重试**一次**，仍失败则换成 `role="img"` 的占位块（保留 `alt`/`aria-label`，如头像显示「安」），**不再发起请求**——没有重试风暴，也没有 JS 未捕获异常。浏览器自身对被 abort/404 的资源仍会打一条网络日志，这是浏览器行为，不是应用报错。

## 验证

- `npm run test:brand`：基址优先级与规范化、URL 拼接与文件名白名单、重试一次后降级、存储键白名单、发布/复读/幂等/非法字节。
- `npm run test:heatmap`：热力域计算（见下）。
- 浏览器实测（需 Chromium + `ws`）：`CHROMIUM_PATH=... WS_MODULE=... node scripts/test-brand-heatmap-browser.mjs`，截图落在 agent artifacts 目录。用原生 CDP 而非 playwright（本机 playwright-core 副本的 selector 引擎在实测中不可用）。