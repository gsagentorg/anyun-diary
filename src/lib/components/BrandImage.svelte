<script lang="ts">
  import { BRAND_MAX_ATTEMPTS, brandAttemptSrc, brandExhausted } from '$lib/brand';

  let {
    src,
    alt,
    cls = '',
    initial = '安',
  }: { src: string; alt: string; cls?: string; initial?: string } = $props();

  // 0 = 首次请求；失败重试一次；用尽后降级为占位，不再发请求（避免控制台报错风暴）。
  let attempt = $state(0);
  const exhausted = $derived(brandExhausted(attempt));
  const current = $derived(brandAttemptSrc(src, attempt));

  function failed() {
    if (attempt < BRAND_MAX_ATTEMPTS) attempt += 1;
  }
</script>

{#if exhausted}
  <span
    role="img"
    aria-label={alt}
    title={alt}
    class="{cls} inline-flex select-none items-center justify-center bg-base-200 text-2xs opacity-60"
    data-brand-placeholder={alt}
  >{initial}</span>
{:else}
  <!-- 纯展示图：不设 crossorigin（无 canvas/像素读取），避免给存储/CDN 增加第二份 CORS 面 -->
  <img
    src={current}
    {alt}
    title={alt}
    class={cls}
    decoding="async"
    draggable="false"
    data-brand-image={alt}
    onerror={failed}
  />
{/if}