export type ReaderTheme = 'white' | 'cream' | 'graphite';

/** Old books use light and dark in their saved appearance. */
export function readerTheme(theme?: string): ReaderTheme {
  if (theme === 'dark' || theme === 'graphite') return 'graphite';
  if (theme === 'cream') return 'cream';
  return 'white';
}

const panelKey = 'language-reader.drawer-width';
export const defaultPanelWidth = 348;

export function savedPanelWidth(): number {
  try {
    const text = window.localStorage.getItem(panelKey);
    const width = text === null ? NaN : Number(text);
    return Number.isFinite(width) && width >= 248 && width <= 560 ? width : defaultPanelWidth;
  } catch {
    return defaultPanelWidth;
  }
}

export function rememberPanelWidth(value: number) {
  try {
    window.localStorage.setItem(panelKey, String(Math.min(560, Math.max(248, Math.round(value)))));
  } catch { /* Resizing remains available if persistent storage is disabled. */ }
}

export function panelBounds(containerWidth: number, compact: boolean) {
  const maximum = Math.max(1, Math.min(560, containerWidth - (compact ? 14 : 215)));
  return {minimum: Math.min(248, maximum), maximum};
}
