import adapterNode from '@sveltejs/adapter-node';
import adapterStatic from '@sveltejs/adapter-static';
import adapterVercel from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // DEPLOY_TARGET=vercel → Vercel（Serverless 函数）；
    // DEPLOY_TARGET=capacitor → 静态单目录（cap/，给 Capacitor webDir 用）；
    // 默认 node（本地自托管部署，node build）
    adapter: process.env.DEPLOY_TARGET === 'vercel'
      ? adapterVercel({ runtime: 'nodejs20.x' })
      : process.env.DEPLOY_TARGET === 'capacitor'
        // strict=false：/api/live 是服务端代理端点，App 内不可用（前端已优雅降级），不需要它进静态包
        ? adapterStatic({ pages: 'cap', assets: 'cap', strict: false })
        : adapterNode(),
  },
};

export default config;
