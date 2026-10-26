// Theme stays on this device. It is not part of the sheet sync payload.

export const THEME_KEY = 'figure-cap.theme';

export function normalizeTheme(value) {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function resolveMode(choice, prefersDark) {
  const theme = normalizeTheme(choice);
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersDark ? 'dark' : 'light';
}

export function themeColorFor(mode) {
  return mode === 'dark' ? '#121212' : '#f5f5f7';
}

export function readTheme(storage) {
  try {
    return normalizeTheme(storage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

export function writeTheme(storage, choice) {
  const theme = normalizeTheme(choice);
  storage.setItem(THEME_KEY, theme);
  return theme;
}

export function applyTheme(choice, prefersDark, doc = globalThis.document) {
  const theme = normalizeTheme(choice);
  const mode = resolveMode(theme, prefersDark);
  const root = doc?.documentElement;
  if (root) {
    root.dataset.theme = theme;
    root.dataset.mode = mode;
  }
  const color = doc?.querySelector?.('meta[name="theme-color"]');
  if (color) color.setAttribute('content', themeColorFor(mode));
  const scheme = doc?.querySelector?.('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute('content', mode);
  return { theme, mode };
}
