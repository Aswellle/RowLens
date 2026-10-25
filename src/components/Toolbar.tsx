/**
 * Toolbar: global search, column-filter and column-visibility popovers, and
 * a narrow-viewport "More" menu holding the still-upcoming features (which
 * stay visibly disabled rather than pretending to work).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Popover } from './Popover';

export type ToolbarColumn = { id: string; label: string };

type ToolbarProps = {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  columns: ToolbarColumn[];
  columnFilters: Readonly<Record<string, string>>;
  onColumnFilterChange: (columnId: string, value: string) => void;
  onClearFilters: () => void;
  hiddenColumns: ReadonlySet<string>;
  onToggleColumn: (columnId: string, visible: boolean) => void;
};

const PENDING_FEATURES = [
  { key: 'clean', label: 'Clean steps', note: 'Cleaning steps arrive in a later update.' },
  { key: 'export', label: 'Export', note: 'Export arrives after cleaning steps.' },
];

export function Toolbar({
  searchTerm,
  onSearchChange,
  columns,
  columnFilters,
  onColumnFilterChange,
  onClearFilters,
  hiddenColumns,
  onToggleColumn,
}: ToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.toolbar__more')) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [moreOpen]);

  const activeFilterCount = Object.values(columnFilters).filter((value) => value !== '').length;

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

      <div className="toolbar__panels">
        <Popover
          id="column-filters-panel"
          label="Column filters"
          triggerLabel={activeFilterCount > 0 ? `Filter · ${activeFilterCount}` : 'Filter'}
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
        >
          {columns.map((column) => (
            <div className="toolbar__panel-row" key={column.id}>
              <label htmlFor={`filter-${column.id}`} className="truncate">
                {column.label}
              </label>
              <input
                id={`filter-${column.id}`}
                className="text-input"
                type="text"
                value={columnFilters[column.id] ?? ''}
                onChange={(event) => onColumnFilterChange(column.id, event.target.value)}
                placeholder="contains…"
              />
            </div>
          ))}
          <button type="button" className="btn" onClick={onClearFilters}>
            Clear all filters
          </button>
        </Popover>

        <Popover
          id="column-visibility-panel"
          label="Visible columns"
          triggerLabel="Columns"
          open={columnsOpen}
          onOpenChange={setColumnsOpen}
        >
          {columns.map((column) => (
            <div className="toolbar__panel-row" key={column.id}>
              <label>
                <input
                  type="checkbox"
                  checked={!hiddenColumns.has(column.id)}
                  onChange={(event) => onToggleColumn(column.id, event.target.checked)}
                />
                <span className="truncate">{column.label}</span>
              </label>
            </div>
          ))}
        </Popover>
      </div>

      <div className="toolbar__more">
        <button
          ref={moreButtonRef}
          type="button"
          className="btn"
          aria-haspopup="true"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          More ▾
        </button>
        <div
          className="toolbar__actions"
          data-open={moreOpen}
          onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
            if (event.key === 'Escape') {
              setMoreOpen(false);
              moreButtonRef.current?.focus();
            }
          }}
        >
          {PENDING_FEATURES.map((feature) => (
            <button
              key={feature.key}
              type="button"
              className="btn"
              disabled
              aria-disabled="true"
              title={feature.note}
            >
              {feature.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
