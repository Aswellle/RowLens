/**
 * Non-sensitive UI preference: light/dark theme. Resolves the stored choice,
 * falls back to the OS preference, and applies it as `data-theme` on <html>.
 * localStorage failures (private mode, blocked) degrade silently.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark';

const STORAGE_KEY = 'rowlens-theme';

function resolveInitial(): ThemePreference {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // storage unavailable — fall through to OS preference
  }
  // matchMedia is missing in some embedded webviews; default to light then.
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function useTheme(): { theme: ThemePreference; toggleTheme: () => void } {
  const [theme, setTheme] = useState<ThemePreference>(resolveInitial);

  useEffect(() => {
    // A theme flip changes background, border and color on nearly every
    // element at once; letting each transition run turns the switch into a
    // smear. Kill all transitions for one frame, force a reflow, restore.
    const root = document.documentElement;
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{transition:none !important}';
    root.dataset.theme = theme;
    root.appendChild(style);
    void root.offsetHeight;
    requestAnimationFrame(() => {
      style.remove();
    });
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // preference just will not persist; nothing to recover
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme };
}
