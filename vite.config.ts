import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit(), tailwindcss()],
  preview: {
    host: true,
    port: 4173,
    // 公网经 frpc 隧道访问（anyun-diary.public.bcw2.top:3004）
    allowedHosts: ['anyun-diary.public.bcw2.top']
  }
});
