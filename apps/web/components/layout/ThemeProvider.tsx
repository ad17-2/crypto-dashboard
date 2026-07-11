'use client';

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { writePrefs } from '@/lib/prefs';

export type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Owns the light/dark toggle state. The actual flash-of-wrong-theme prevention happens before
 * hydration via the `beforeInteractive` script in app/layout.tsx, which stamps `data-theme` on
 * `<html>` directly from localStorage; this provider's initial render always assumes "dark" (the
 * server-safe default) and syncs to the real value on mount, so there is no hydration mismatch —
 * only a same-frame correction of dependent UI (e.g. the toggle button's label).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    if (current === 'light') setTheme('light');
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((previous) => {
      const next: Theme = previous === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      writePrefs({ theme: next });
      return next;
    });
  }, []);

  return <ThemeContext value={{ theme, toggleTheme }}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return value;
}
