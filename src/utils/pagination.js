/**
 * pagination.js — Standardized cursor (keyset) pagination for time-ordered,
 * indexed collections.
 *
 * CONTRACT
 *   Request:  ?limit=N (default 25, max 100) & cursor=<ISO date of the last row
 *             of the previous page>, alongside any existing filters.
 *   Response: {
 *     status: true,
 *     data: [...],
 *     pagination: { limit, next_cursor: <ISO|null>, has_more: <bool>, count }
 *   }
 *
 * MECHANICS (keyset — NEVER .skip()):
 *   - When a cursor is present, filter <sortField>: { $lt: new Date(cursor) }.
 *   - .sort({ <sortField>: -1 }).limit(limit + 1) — fetch one extra sentinel row
 *     to detect a following page without a second count query.
 *   - has_more    = rows.length > limit (then slice back to `limit`).
 *   - next_cursor = the sortField of the last returned row as an ISO string
 *     (or null when there is no further page).
 *
 * Callers MUST pair this with .lean() + a projection + an index that covers
 * (filters..., sortField desc). Where a collection has no created_at, pass a
 * different time key (e.g. `timestamp`, `granted_at`) as `sortField`.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Whether the request opted into the paginated envelope. True when either
 * ?limit or ?cursor is present, so legacy callers that pass neither keep the
 * old (unpaginated) response shape for back-compat.
 */
function isPaginated(query) {
  return query && (query.limit !== undefined || query.cursor !== undefined);
}

/** Clamp ?limit into [1, MAX_LIMIT], defaulting to DEFAULT_LIMIT. */
function parseLimit(raw, { def = DEFAULT_LIMIT, max = MAX_LIMIT } = {}) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

/**
 * Parse a cursor into a Date. Returns:
 *   { valid: true,  date: Date }  when parseable,
 *   { valid: true,  date: null }  when absent (no cursor → first page),
 *   { valid: false }              when present but unparseable.
 */
function parseCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return { valid: true, date: null };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { valid: false };
  return { valid: true, date: d };
}

/**
 * Apply the keyset cursor predicate to an existing filter object (mutates and
 * returns it). Adds `<sortField>: { $lt: cursorDate }` when a cursor is set.
 */
function applyCursorFilter(filter, cursorDate, sortField = 'created_at') {
  if (cursorDate) filter[sortField] = { $lt: cursorDate };
  return filter;
}

/**
 * Build the { data, pagination } envelope from a raw result set that was
 * fetched with .limit(limit + 1). Slices off the sentinel row and derives
 * has_more / next_cursor from the sortField of the last returned row.
 */
function buildPage(rows, limit, sortField = 'created_at') {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = null;
  if (hasMore && data.length) {
    const last = data[data.length - 1][sortField];
    nextCursor = last instanceof Date ? last.toISOString()
      : last != null ? new Date(last).toISOString()
      : null;
  }
  return {
    data,
    pagination: {
      limit,
      next_cursor: nextCursor,
      has_more: hasMore,
      count: data.length,
    },
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  isPaginated,
  parseLimit,
  parseCursor,
  applyCursorFilter,
  buildPage,
};
