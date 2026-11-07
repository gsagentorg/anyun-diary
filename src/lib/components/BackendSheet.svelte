<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { backend, saveBackendBase, dismissBackendPrompt } from '$lib/backend.svelte';

  // 每次弹窗打开时预填当前生效地址（可能是已保存的覆盖值，也可能是构建期默认）
  let url = $state('');
  $effect(() => {
    if (backend.prompt) url = backend.base;
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    saveBackendBase(url);
  }
</script>

<Sheet
  side="bottom"
  title="后端地址"
  open={backend.prompt}
  onClose={dismissBackendPrompt}
>
  <form class="flex flex-col gap-3 px-4 py-4" onsubmit={submit}>
    <p class="text-xs leading-relaxed opacity-70">
      索引与切片音频都从该地址拉取：索引按
      <code class="rounded bg-base-200 px-1">地址 /data.json</code>，音频按
      <code class="rounded bg-base-200 px-1">地址 /audio/文件名</code>。
      填站点根地址（结尾不带 /audio），例如
      <span class="break-all">https://xxxx.public.blob.vercel-storage.com</span>。请使用
      https（iOS 会拦截明文 http）。
    </p>
    <input
      class="w-full rounded-lg border border-base-300 bg-base-100 px-3 py-2 text-sm outline-none transition focus:border-accent"
      type="url"
      placeholder="https://…"
      bind:value={url}
      required
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      inputmode="url"
    />
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="rounded-full border border-base-300 px-3 py-1 text-sm opacity-70 transition hover:opacity-100"
        onclick={dismissBackendPrompt}
      >
        稍后
      </button>
      <button
        type="submit"
        class="rounded-full border border-accent bg-accent px-4 py-1 text-sm text-base-100 transition hover:opacity-90"
      >
        保存
      </button>
    </div>
  </form>
</Sheet>
