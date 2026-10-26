/**
 * Toolbar: global search (with the opt-in `column:value` syntax hint), the
 * column-filter and column-visibility popovers, and Export. On narrow
 * viewports the sections wrap instead of hiding behind a menu, so every tool
 * stays visible and reachable at any width.
 */
import { useState } from 'react';
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
  onExport: () => void;
};

export function Toolbar({
  searchTerm,
  onSearchChange,
  columns,
  columnFilters,
  onColumnFilterChange,
  onClearFilters,
  hiddenColumns,
  onToggleColumn,
  onExport,
}: ToolbarProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);

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
          aria-describedby="global-search-hint"
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && searchTerm !== '') {
              onSearchChange('');
              // Focus stays in the input per UI spec §4.
              event.preventDefault();
            }
          }}
        />
        {/* Kept out of the layout: the syntax is opt-in, not a tutorial. */}
        <span id="global-search-hint" className="visually-hidden">
          Space separates terms that must all match. Write a column name, a colon, then text to
          search only that column, quoting names with spaces: Status:open, &quot;First response
          (h)&quot;:14
        </span>
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
        <button type="button" className="btn btn--primary" onClick={onExport}>
          Export
        </button>
      </div>
    </div>
  );
}
