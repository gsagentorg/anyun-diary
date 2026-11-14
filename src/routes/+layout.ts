import { dev } from '$app/environment';
import { injectAnalytics } from '@vercel/analytics/sveltekit';
import { initTheme } from '$lib/theme.svelte.ts';

export const prerender = false;

injectAnalytics({ mode: dev ? 'development' : 'production' });

initTheme();
