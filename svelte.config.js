import adapterNode from '@sveltejs/adapter-node';
import adapterVercel from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // DEPLOY_TARGET=vercel → Vercel（Serverless 函数）；默认 node（本地自托管部署，node build）
    adapter: process.env.DEPLOY_TARGET === 'vercel'
      ? adapterVercel({ runtime: 'nodejs20.x' })
      : adapterNode(),
  },
};

export default config;
