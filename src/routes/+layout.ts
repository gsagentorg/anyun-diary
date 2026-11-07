import { initTheme } from '$lib/theme.svelte.ts';
import { initBackend } from '$lib/backend.svelte';

export const prerender = true;

initTheme();
initBackend();
