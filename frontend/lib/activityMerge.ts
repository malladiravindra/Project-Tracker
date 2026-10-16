// Pure helpers for paged, newest-first activity lists. No imports.

export interface HasId {
  id: string | number;
}

export const PAGE_SIZE = 50;
export const MAX_PAGE = 200; // server limit per request

/** Append `incoming` to `existing`, skipping ids already present (a new event at the head shifts later pages). */
export function appendUnique<T extends HasId>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((x) => String(x.id)));
  const out = existing.slice();
  for (const x of incoming) {
    const key = String(x.id);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(x);
    }
  }
  return out;
}

export interface PageResult<T> {
  results: T[];
  count: number;
}

/**
 * Re-read as many rows as are currently loaded (at least `minimum`), in requests of at most MAX_PAGE rows.
 * Rows come back newest first, deduplicated by id, so nothing duplicates or vanishes.
 * When everything was loaded before (`loadedAll`), keep reading until the server's new total is reached, so a
 * freshly added event does not push the oldest row out of the list.
 */
export async function reloadLoaded<T extends HasId>(
  loaded: number,
  fetchPage: (limit: number, offset: number) => Promise<PageResult<T>>,
  minimum = PAGE_SIZE,
  loadedAll = false,
): Promise<{ rows: T[]; count: number }> {
  const want = loadedAll ? Number.POSITIVE_INFINITY : Math.max(loaded, minimum);
  let rows: T[] = [];
  let count = 0;
  let offset = 0;
  while (offset < want) {
    const page = await fetchPage(Math.min(MAX_PAGE, want - offset), offset);
    count = page.count;
    rows = appendUnique(rows, page.results);
    offset += page.results.length > 0 ? page.results.length : MAX_PAGE;
    if (page.results.length === 0 || offset >= count) break;
  }
  return { rows, count };
}

/** True while the server has more rows than are loaded. */
export const hasMore = (loaded: number, count: number) => loaded < count;

/**
 * Fetch the next page after the rows already loaded (offset = rows loaded) and merge it in without
 * duplicates. If a whole page turns out to be rows we already hold (many new events landed at the head),
 * keep moving the offset forward so "Load more" always makes progress.
 */
export async function loadNextPage<A extends HasId, T extends HasId>(
  existing: T[],
  fetchPage: (limit: number, offset: number) => Promise<PageResult<A>>,
  map: (a: A) => T,
  size = PAGE_SIZE,
): Promise<{ rows: T[]; count: number }> {
  let rows = existing;
  let count = 0;
  let offset = existing.length;
  for (let i = 0; i < 20; i++) {
    const page = await fetchPage(size, offset);
    count = page.count;
    const merged = appendUnique(rows, page.results.map(map));
    const grew = merged.length > rows.length;
    rows = merged;
    if (grew || page.results.length === 0) break;
    offset += page.results.length;
  }
  return { rows, count };
}
