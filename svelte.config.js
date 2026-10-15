import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Vercel：SSR 页面 + /api/playlist 服务端函数（动态播放列表 m3u）
    adapter: adapter({ runtime: 'nodejs20.x' })
  }
};

export default config;
