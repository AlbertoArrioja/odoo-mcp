import { OdooError } from './errors.js';

/**
 * Version-aware grouping helpers behind OdooClient.readGroup().
 *
 * Odoo 19+ : `formatted_read_group(domain, groupby, aggregates, having, offset,
 *            limit, order)` (web module, @api.readonly). Aggregates are keyed
 *            by their spec (`amount_total:sum`); a date groupby value is a
 *            `[range_start, label]` pair.
 * Odoo ≤ 18: `read_group(domain, fields, groupby, offset, limit, orderby, lazy)`
 *            with lazy=False. Aggregates are requested as `alias:func(field)`
 *            and keyed by alias; a date groupby value is only the label, with
 *            the bounds in `__range[spec] = { from, to }`.
 *
 * Both are normalised to the same row shape (see ReadGroupRow).
 * Source checked against odoo/odoo 17.0 + 18.0 `odoo/models.py` and 19.0
 * `addons/web/models/models.py`.
 */

/** First Odoo major version that ships `formatted_read_group`. */
export const FORMATTED_READ_GROUP_MIN_MAJOR = 19;

/**
 * One normalised group. Keys:
 *   - each groupby spec, e.g. `partner_id` → `[id, display_name]` or `false`;
 *     `date_order:month` → `{ value: '2026-01-01', label: 'January 2026' }`
 *     or `false`; other field types → the raw value.
 *   - each aggregate spec, e.g. `amount_total:sum` → number | null.
 *   - `__count` → number of records in the group.
 */
export type ReadGroupRow = Record<string, unknown>;

export interface ReadGroupRequest {
  domain: unknown[];
  /** Groupby specs: `field` or `field:granularity`. */
  groupby: string[];
  /** Aggregate specs: `field:func`. */
  aggregates: string[];
  /** Comma-separated terms over groupby specs, aggregate specs or `__count`, each optionally followed by asc/desc. */
  orderby?: string;
  limit?: number;
}

/** A groupby spec carries a date granularity iff it contains ':'. */
function isDateSpec(spec: string): boolean {
  return spec.includes(':');
}

/** Alias used for an aggregate on Odoo ≤ 18 (`amount_total:sum` → `amount_total__sum`). */
function legacyAlias(aggregateSpec: string): string {
  const [field, func] = aggregateSpec.split(':');
  return `${field}__${func}`;
}

/** Parse `common.version` → major version number. Handles `saas~18` style ids. */
export function parseMajorVersion(version: unknown): number {
  const info = (version as { server_version_info?: unknown[] } | null)?.server_version_info;
  const candidates = [
    Array.isArray(info) ? info[0] : undefined,
    (version as { server_version?: unknown } | null)?.server_version,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const match = candidate.match(/(\d+)/);
      if (match) return Number(match[1]);
    }
  }
  throw new OdooError('ServerError', 'Could not determine Odoo server version from common.version');
}

/**
 * Translate an orderby string to what each Odoo branch expects.
 *   19+  : specs are accepted as-is by formatted_read_group's `order`.
 *   ≤ 18 : read_group matches groupby terms by bare field name and aggregate
 *          terms by alias.
 */
function translateOrderby(orderby: string, req: ReadGroupRequest, legacy: boolean): string {
  if (!legacy) return orderby;
  return orderby
    .split(',')
    .map((term) => {
      const [key, direction] = term.trim().split(/\s+/);
      let translated = key;
      if (req.aggregates.includes(key)) translated = legacyAlias(key);
      else if (req.groupby.includes(key)) translated = key.split(':')[0];
      return direction ? `${translated} ${direction}` : translated;
    })
    .join(', ');
}

/** Build `[method, args, kwargs]` for the execute_kw call on the given major version. */
export function buildReadGroupCall(
  major: number,
  req: ReadGroupRequest,
  context?: Record<string, unknown>,
): {
  method: 'formatted_read_group' | 'read_group';
  args: unknown[];
  kwargs: Record<string, unknown>;
} {
  const legacy = major < FORMATTED_READ_GROUP_MIN_MAJOR;
  const kwargs: Record<string, unknown> = {};
  if (req.limit !== undefined) kwargs.limit = req.limit;
  if (context !== undefined) kwargs.context = context;

  if (!legacy) {
    kwargs.groupby = req.groupby;
    // __count is not implicit on formatted_read_group — always request it.
    kwargs.aggregates = [...req.aggregates, '__count'];
    if (req.orderby) kwargs.order = translateOrderby(req.orderby, req, false);
    return { method: 'formatted_read_group', args: [req.domain], kwargs };
  }

  kwargs.fields = req.aggregates.map((spec) => {
    const [field, func] = spec.split(':');
    return `${legacyAlias(spec)}:${func}(${field})`;
  });
  kwargs.groupby = req.groupby;
  // lazy=False: group by every groupby at once and return `__count`.
  kwargs.lazy = false;
  if (req.orderby) kwargs.orderby = translateOrderby(req.orderby, req, true);
  return { method: 'read_group', args: [req.domain], kwargs };
}

/** Normalise raw rows from either branch to ReadGroupRow[]. */
export function normalizeReadGroupRows(
  major: number,
  req: ReadGroupRequest,
  rows: unknown,
): ReadGroupRow[] {
  if (!Array.isArray(rows)) {
    throw new OdooError('ServerError', 'Unexpected read_group response: expected an array');
  }
  const legacy = major < FORMATTED_READ_GROUP_MIN_MAJOR;

  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const out: ReadGroupRow = {};

    for (const spec of req.groupby) {
      const value = row[spec];
      if (!isDateSpec(spec)) {
        out[spec] = value ?? false;
        continue;
      }
      if (legacy) {
        // __range[spec] is { from, to } for a dated group, false for "no date".
        const ranges = row.__range as Record<string, { from?: string } | false> | undefined;
        const from = ranges?.[spec] ? (ranges[spec] as { from?: string }).from : undefined;
        out[spec] = from ? { value: from, label: value } : false;
      } else {
        out[spec] = Array.isArray(value) ? { value: value[0], label: value[1] } : false;
      }
    }

    for (const spec of req.aggregates) {
      const value = legacy ? row[legacyAlias(spec)] : row[spec];
      out[spec] = value ?? null;
    }

    out.__count = row.__count ?? 0;
    return out;
  });
}
