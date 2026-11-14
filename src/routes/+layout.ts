import { dev } from '$app/environment';
import { injectAnalytics } from '@vercel/analytics/sveltekit';
import { initTheme } from '$lib/theme.svelte.ts';
import { initBackend } from '$lib/backend.svelte';

export const prerender = false;

injectAnalytics({ mode: dev ? 'development' : 'production' });

initTheme();
initBackend();
