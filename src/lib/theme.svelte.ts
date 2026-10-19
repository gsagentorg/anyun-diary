export const theme = $state<{
  mode: 'light' | 'dark' | 'system';
  resolved: 'light' | 'dark';
}>({ mode: 'system', resolved: 'light' });

const KEY = 'anyun-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

function apply() {
  theme.resolved = theme.mode === 'system' ? (systemDark() ? 'dark' : 'light') : theme.mode;
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme.resolved;
}

export function toggleTheme() {
  theme.mode = theme.mode === 'system' ? 'light' : theme.mode === 'light' ? 'dark' : 'system';
  apply();
  try {
    localStorage.setItem(KEY, theme.mode);
  } catch {
    /* 隐私模式下写失败不致命 */
  }
}

/** 启动入口（+layout 顶层调用）：localStorage → system */
export function initTheme() {
  if (typeof document === 'undefined') return;
  let m: 'light' | 'dark' | 'system' = 'system';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') m = saved;
  } catch {
    /* localStorage 不可用则用默认 system */
  }
  theme.mode = m;
  apply();
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
      if (theme.mode !== 'system') return;
      apply();
    });
  }
}
