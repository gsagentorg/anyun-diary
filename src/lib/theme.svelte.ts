export const theme = $state<{ mode: 'light' | 'dark' }>({ mode: 'light' });

const KEY = 'anyun-theme';

function apply() {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme.mode;
}

export function toggleTheme() {
  theme.mode = theme.mode === 'dark' ? 'light' : 'dark';
  apply();
  try {
    localStorage.setItem(KEY, theme.mode);
  } catch {
    /* 隐私模式下写失败不致命 */
  }
}

/** 启动入口（+layout 顶层调用）：localStorage → 系统偏好 → light */
export function initTheme() {
  if (typeof document === 'undefined') return;
  let m: 'light' | 'dark' = 'light';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') m = saved;
    else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) m = 'dark';
  } catch {
    /* localStorage 不可用则用默认 */
  }
  theme.mode = m;
  apply();
}
