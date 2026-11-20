// System / Light / Dark, remembered per browser (the only localStorage use in the app; lint).
// Storage can be missing or throw (private windows), so every access is guarded.

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'theme';

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: ThemeChoice): void {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // Not remembered; the choice still applies to this page.
  }
}
