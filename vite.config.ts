import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 开发模式：本地 dev server，经独立 frpc 容器暴露到 anyun-diary.public.bcw2.top:3004
// 部署走 Vercel，不在这里做 preview/静态服务。
export default defineConfig({
  plugins: [sveltekit(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173, // 开发实例；生产(adapter-node)占 4173
    strictPort: true,
    // dev 阶段放行全部 Host（owner 2026-11-12 定），便于任意隧道/域名接入
    allowedHosts: true
  }
});
