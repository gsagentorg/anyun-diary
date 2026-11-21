<script lang="ts">
  import '../app.css';
  import Player from '$lib/Player.svelte';
  import { onMount } from 'svelte';
  import { Capacitor } from '@capacitor/core';
  import { browser, dev } from '$app/environment';
  import { base } from '$app/paths';

  onMount(() => {
    if (Capacitor.getPlatform() !== 'ios') return;
    const viewport = document.querySelector('meta[name="viewport"]');
    const original = viewport?.getAttribute('content');
    viewport?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    document.documentElement.classList.add('native-ios');
    return () => {
      document.documentElement.classList.remove('native-ios');
      if (original != null) viewport?.setAttribute('content', original);
    };
  });

  let { children } = $props();

  // 离线 shell 仅网页启用：https/localhost、生产构建、非 Capacitor（App 内离线音频/索引由 Swift 原生缓存承担）。
  // 前提：svelte.config.js 已设 kit.serviceWorker.register=false（SvelteKit 默认会自动注册，会绕过这里的环境判定），
  // 因此这里是唯一注册点；更新等待旧页面关闭，不强刷页面、不打断播放。
  onMount(() => {
    if (!browser || !('serviceWorker' in navigator) || Capacitor.isNativePlatform()) return;
    if (dev) {
      // 开发模式不加载 SW；顺手卸掉同源旧注册，避免残留 service-worker.js 干扰 dev。
      void navigator.serviceWorker.getRegistration(`${base}/`).then((r) => {
        if (r && r.active?.scriptURL.endsWith('/service-worker.js')) void r.unregister();
      }).catch(() => {});
      return;
    }
    if (!window.isSecureContext) return;
    void navigator.serviceWorker.register(`${base}/service-worker.js`).catch(() => {});
  });
</script>

{@render children()}
<Player />
