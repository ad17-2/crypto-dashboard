'use client';

import { useTheme } from './ThemeProvider';

/** Label shows the theme you'd switch *to*, not the current theme. */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle color theme"
      className="theme-btn link cursor-pointer bg-transparent border-0 p-0"
    >
      {theme === 'light' ? 'Dark' : 'Light'}
    </button>
  );
}
