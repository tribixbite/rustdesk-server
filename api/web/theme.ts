/**
 * Colour theme preference: dark by default, or light, or follow the system
 * (prefers-color-scheme). Applied as <html data-theme>, read by styles.css.
 */

export type Theme = "dark" | "light" | "system";

const KEY = "rustdesk-console-theme";
export const THEMES: readonly Theme[] = ["dark", "light", "system"];

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    // storage blocked: use the default
  }
  return "dark";
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme): void {
  applyTheme(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // storage blocked: the choice lasts for this page load
  }
}
