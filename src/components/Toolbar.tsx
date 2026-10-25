/**
 * Toolbar: global search plus feature entry points. Search is live in the
 * Phase 1 demo (synthetic data); Filter / Columns / Clean steps / Export are
 * visibly disabled until their phases land — the UI never pretends they work.
 *
 * Narrow viewports (<700px) collapse the feature buttons behind a "More"
 * menu (UI spec §7) with Escape-to-close and focus return.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

type ToolbarProps = {
  searchTerm: string;
  onSearchChange: (value: string) => void;
};

type DisabledAction = {
  key: string;
  label: string;
  note: string;
};

/** Feature buttons stay visible-but-disabled so the main path is learnable. */
const DISABLED_ACTIONS: DisabledAction[] = [
  { key: 'filter', label: 'Filter', note: 'Column filters arrive in Phase 3.' },
  { key: 'columns', label: 'Columns', note: 'Column visibility arrives in Phase 3.' },
  { key: 'clean', label: 'Clean steps', note: 'Cleaning steps arrive in Phase 4.' },
  { key: 'export', label: 'Export', note: 'Export arrives after a real file can be imported.' },
];

export function Toolbar({ searchTerm, onSearchChange }: ToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.toolbar__more')) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      setMenuOpen(false);
      moreButtonRef.current?.focus();
    }
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Data tools">
      <div className="toolbar__search">
        <label htmlFor="global-search" className="visually-hidden">
          Search all columns
        </label>
        <input
          id="global-search"
          className="text-input"
          type="search"
          placeholder="Search all columns…"
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && searchTerm !== '') {
              onSearchChange('');
              // Focus stays in the input per UI spec §4.
              event.preventDefault();
            }
          }}
        />
        {searchTerm !== '' && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onSearchChange('');
              document.getElementById('global-search')?.focus();
            }}
            aria-label="Clear search input"
          >
            Clear
          </button>
        )}
      </div>

      <div className="toolbar__more">
        <button
          ref={moreButtonRef}
          type="button"
          className="btn"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          More ▾
        </button>
        <div className="toolbar__actions" data-open={menuOpen} onKeyDown={onMenuKeyDown}>
          {DISABLED_ACTIONS.map((action) => (
            <button
              key={action.key}
              type="button"
              className="btn"
              disabled
              aria-disabled="true"
              title={action.note}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
