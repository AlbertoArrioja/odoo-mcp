import { OdooError } from './errors.js';

/**
 * Read-only allowlist — second line of defense behind the MCP tool surface.
 *
 * Every request this package sends to Odoo goes through `jsonRpc()`, which
 * calls `assertReadOnlyRpc()` BEFORE the request leaves the process. Anything
 * not explicitly listed here is rejected locally and never reaches Odoo:
 *
 *   - endpoint: only `/jsonrpc` (the classic external API).
 *   - service `common`: only `authenticate` (login check) and `version`.
 *   - service `object`: only `execute_kw`, and only with a model method from
 *     ALLOWED_EXECUTE_KW_METHODS.
 *   - every other service (`db` can create/duplicate/drop databases, `report`,
 *     …) and the legacy `object.execute` are rejected.
 *
 * To allow a new method, add it here AND prove it cannot modify data on any
 * supported Odoo version. Methods like create/write/unlink/copy, action_*,
 * button_*, message_post, or any private `_method` must never be added.
 */
export const ALLOWED_EXECUTE_KW_METHODS: ReadonlySet<string> = new Set([
  'search_read',
  'read',
  'search_count',
  'fields_get',
  // Aggregation: read_group (Odoo ≤ 18, deprecated but @api.readonly in 19)
  // and formatted_read_group (web module, Odoo 19+, @api.readonly).
  'read_group',
  'formatted_read_group',
  // res.users.context_get — user lang/tz, used by authentication + probe.
  'context_get',
]);

const ALLOWED_COMMON_METHODS: ReadonlySet<string> = new Set(['authenticate', 'version']);

const ALLOWED_ENDPOINT = '/jsonrpc';

/** Thrown when a request would leave the read-only allowlist. Never retried. */
export class OdooReadOnlyViolation extends OdooError {
  constructor(message: string, model?: string, method?: string) {
    super('ReadOnlyViolation', `ReadOnlyViolation: ${message}`, model, method);
    this.name = 'OdooReadOnlyViolation';
  }
}

/**
 * Throws OdooReadOnlyViolation unless `endpoint` + `params` describe an
 * allowlisted read-only call. Pure and synchronous — no network access.
 */
export function assertReadOnlyRpc(endpoint: string, params: Record<string, unknown>): void {
  if (endpoint !== ALLOWED_ENDPOINT) {
    throw new OdooReadOnlyViolation(`endpoint ${JSON.stringify(endpoint)} is not allowed`);
  }

  const { service, method, args } = params;

  if (service === 'common') {
    if (typeof method === 'string' && ALLOWED_COMMON_METHODS.has(method)) return;
    throw new OdooReadOnlyViolation(`common.${String(method)} is not allowed`);
  }

  if (service === 'object') {
    if (method !== 'execute_kw') {
      throw new OdooReadOnlyViolation(`object.${String(method)} is not allowed; use execute_kw`);
    }
    // execute_kw args: [db, uid, password, model, method, args, kwargs]
    const model = Array.isArray(args) ? args[3] : undefined;
    const modelMethod = Array.isArray(args) ? args[4] : undefined;
    if (typeof modelMethod === 'string' && ALLOWED_EXECUTE_KW_METHODS.has(modelMethod)) return;
    throw new OdooReadOnlyViolation(
      `method ${JSON.stringify(modelMethod)} is not in the read-only allowlist`,
      typeof model === 'string' ? model : undefined,
      typeof modelMethod === 'string' ? modelMethod : undefined,
    );
  }

  throw new OdooReadOnlyViolation(`service ${JSON.stringify(service)} is not allowed`);
}
