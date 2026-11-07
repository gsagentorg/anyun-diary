import adapterNode from '@sveltejs/adapter-node';
import adapterVercel from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Vercel 自动设置 VERCEL=1；也支持本地显式选择部署目标。
    adapter: (process.env.DEPLOY_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'node')) === 'vercel'
      ? adapterVercel({ runtime: 'nodejs22.x' })
      : adapterNode(),
  },
};

export default config;
