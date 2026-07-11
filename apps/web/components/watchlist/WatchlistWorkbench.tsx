'use client';

import type { Watchlist, WatchlistId } from '@crypto-screener/contracts';
import { useEffect, useMemo, useState } from 'react';
import { rowKey } from '@/lib/dashboard-row';
import type { WatchlistFilterState } from '@/lib/watchlist-filters';
import { collectSources, DEFAULT_WATCHLIST_FILTERS, filterRows } from '@/lib/watchlist-filters';
import type { SortColumnKey, SortDirection } from '@/lib/watchlist-sort';
import { defaultSortDirection, sortRows } from '@/lib/watchlist-sort';
import { SelectedCoinRail } from './SelectedCoinRail';
import { type Density, WatchlistPanel } from './WatchlistPanel';

export interface WatchlistWorkbenchProps {
  watchlists: Watchlist[];
}

/** localStorage key + shape shared with ThemeProvider — reads/writes here merge rather than
 * overwrite so this never clobbers the `theme` key it doesn't own (see ThemeProvider's header). */
const PREFS_KEY = 'tape.prefs';

interface TapePrefs {
  density?: Density;
  sortKey?: SortColumnKey;
  sortDir?: SortDirection;
  [key: string]: unknown;
}

const SORT_KEYS: readonly SortColumnKey[] = [
  'symbol',
  'setup',
  'score',
  'conf',
  'quality',
  'price',
  'oi',
  'funding',
  'ls',
  'volume',
  'source',
];

function readPrefs(): TapePrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as TapePrefs) : {};
  } catch {
    return {};
  }
}

function writePrefs(patch: Partial<TapePrefs>): void {
  try {
    const prefs = readPrefs();
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, ...patch }));
  } catch {
    // storage unavailable (private browsing, quota) — prefs still apply for this session
  }
}

function defaultTab(watchlists: Watchlist[]): WatchlistId {
  return watchlists.some((list) => list.id === 'chart_next')
    ? 'chart_next'
    : (watchlists[0]?.id ?? 'chart_next');
}

/**
 * Owns every piece of interactive watchlist state — active tab, density, filters, sort, and the
 * selected row — and renders the two-column workbench (table + detail rail) that shares it. Ports
 * the `state` object and its associated handlers from the legacy dashboard.js.
 */
export function WatchlistWorkbench({ watchlists }: WatchlistWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<WatchlistId>(() => defaultTab(watchlists));
  const [density, setDensity] = useState<Density>('comfortable');
  const [filters, setFilters] = useState<WatchlistFilterState>(DEFAULT_WATCHLIST_FILTERS);
  const [sortKey, setSortKey] = useState<SortColumnKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Restore density/sort from localStorage post-mount only, matching ThemeProvider's pattern: the
  // server-safe default renders first (no hydration mismatch), then a same-frame correction syncs
  // dependent UI once the real prefs are known.
  useEffect(() => {
    const prefs = readPrefs();
    if (prefs.density === 'compact' || prefs.density === 'comfortable') setDensity(prefs.density);
    if (typeof prefs.sortKey === 'string' && SORT_KEYS.includes(prefs.sortKey))
      setSortKey(prefs.sortKey);
    if (prefs.sortDir === 'asc' || prefs.sortDir === 'desc') setSortDir(prefs.sortDir);
  }, []);

  const sourceOptions = useMemo(() => collectSources(watchlists), [watchlists]);

  const activeList = useMemo(
    () =>
      watchlists.find((list) => list.id === activeTab) ??
      watchlists[0] ?? { id: activeTab, label: 'Watchlist', rows: [] },
    [watchlists, activeTab],
  );

  const visibleRows = useMemo(
    () => sortRows(filterRows(activeList.rows, filters), sortKey, sortDir),
    [activeList, filters, sortKey, sortDir],
  );

  const effectiveSelectedKey = useMemo(() => {
    if (selectedKey && visibleRows.some((row) => rowKey(row) === selectedKey)) return selectedKey;
    return visibleRows[0] ? rowKey(visibleRows[0]) : null;
  }, [visibleRows, selectedKey]);

  const selectedRow = visibleRows.find((row) => rowKey(row) === effectiveSelectedKey) ?? null;

  const handleTabChange = (id: WatchlistId) => {
    setActiveTab(id);
    setSelectedKey(null);
  };

  const handleDensityChange = (next: Density) => {
    setDensity(next);
    writePrefs({ density: next });
  };

  const handleFiltersChange = (patch: Partial<WatchlistFilterState>) => {
    setFilters((previous) => ({ ...previous, ...patch }));
  };

  const handleSort = (key: SortColumnKey) => {
    if (sortKey === key) {
      const nextDir = sortDir === 'asc' ? 'desc' : 'asc';
      setSortDir(nextDir);
      writePrefs({ sortKey: key, sortDir: nextDir });
    } else {
      const nextDir = defaultSortDirection(key);
      setSortKey(key);
      setSortDir(nextDir);
      writePrefs({ sortKey: key, sortDir: nextDir });
    }
  };

  return (
    <section className="grid grid-cols-[minmax(0,1fr)_390px] max-[1100px]:grid-cols-1 gap-3 items-start">
      <WatchlistPanel
        watchlists={watchlists}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        density={density}
        onDensityChange={handleDensityChange}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        sourceOptions={sourceOptions}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        rows={{ visible: visibleRows, total: activeList.rows.length }}
        selectedKey={effectiveSelectedKey}
        onSelectRow={setSelectedKey}
      />
      <aside className="detail-rail self-stretch">
        <div className="grid gap-3 items-start sticky top-3 max-[1100px]:static">
          <SelectedCoinRail row={selectedRow} />
        </div>
      </aside>
    </section>
  );
}
