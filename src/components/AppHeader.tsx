import { useTheme } from '../features/settings/useTheme';

export function AppHeader() {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="app-header">
      <span className="app-header__brand">RowLens</span>
      <span className="app-header__badge">Local-only · no uploads</span>
      <span className="app-header__spacer" />
      <button
        type="button"
        className="btn btn--ghost"
        onClick={toggleTheme}
        aria-pressed={theme === 'dark'}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? '☀ Light' : '☾ Dark'}
      </button>
    </header>
  );
}
