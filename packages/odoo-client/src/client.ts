import { type AuthStrategy, createAuthStrategy } from './auth.js';
import { OdooAuthError } from './errors.js';
import {
  type ReadGroupRequest,
  type ReadGroupRow,
  buildReadGroupCall,
  normalizeReadGroupRows,
  parseMajorVersion,
} from './read-group.js';
import { jsonRpc } from './rpc.js';
import type { Context, Domain, OdooConfig, OdooRecord, OdooSession } from './types.js';

// Odoo's classic external-API endpoint. Every authenticated ORM call hits
// /jsonrpc with `service: "object", method: "execute_kw"` and the API key
// passed as the password parameter in the args array. This replaces the
// /web/dataset/call_kw endpoint used in v0.1, which only worked under the
// /web/session/authenticate cookie flow (incompatible with API keys on
// modern Odoo configurations).
const JSONRPC = '/jsonrpc';

// US-4 AC-9: searchRead applies an 80-row default to prevent unbounded payloads.
const DEFAULT_SEARCH_LIMIT = 80;

/** Remove undefined-valued keys from a shallow object, returning a new object */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

export class OdooClient {
  private session?: OdooSession;
  private strategy?: AuthStrategy;
  // common.version is fetched once per client (one client per user session).
  private serverMajor?: Promise<number>;

  constructor(private readonly config: OdooConfig) {}

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async authenticate(): Promise<OdooSession> {
    const strategy = await createAuthStrategy(this.config);
    const session = await strategy.authenticate(this.config);
    this.strategy = strategy;
    this.session = session;
    return session;
  }

  // ---------------------------------------------------------------------------
  // Guard
  // ---------------------------------------------------------------------------

  private requireSession(): OdooSession {
    if (!this.session) {
      throw new OdooAuthError('Not authenticated — call authenticate() first');
    }
    return this.session;
  }

  /**
   * Wrap a single `execute_kw` call. Centralises the wire-format so each ORM
   * method below just declares the model + method + positional args + kwargs.
   */
  private async executeKw(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): Promise<unknown> {
    const session = this.requireSession();
    return jsonRpc(this.config.url, JSONRPC, {
      service: 'object',
      method: 'execute_kw',
      args: [this.config.db, session.uid, this.config.apiKey, model, method, args, kwargs],
    });
  }

  // ---------------------------------------------------------------------------
  // ORM methods
  // ---------------------------------------------------------------------------

  async searchRead(
    model: string,
    domain: Domain,
    fields?: string[],
    options?: { limit?: number; offset?: number; order?: string; context?: Context },
  ): Promise<OdooRecord[]> {
    const { limit, offset, order, context } = options ?? {};
    const kwargs = compact({
      fields,
      limit: limit ?? DEFAULT_SEARCH_LIMIT,
      offset,
      order,
      context,
    });
    const result = await this.executeKw(model, 'search_read', [domain], kwargs);
    return result as OdooRecord[];
  }

  async read(
    model: string,
    ids: number[],
    fields?: string[],
    context?: Context,
  ): Promise<OdooRecord[]> {
    const kwargs = compact({ fields, context });
    const result = await this.executeKw(model, 'read', [ids], kwargs);
    return result as OdooRecord[];
  }

  async searchCount(model: string, domain: Domain, context?: Context): Promise<number> {
    const kwargs = compact({ context });
    const result = await this.executeKw(model, 'search_count', [domain], kwargs);
    return result as number;
  }

  /** res.users.context_get — the caller's lang/tz/etc., used by the startup probe. */
  async contextGet(): Promise<Context> {
    const result = await this.executeKw('res.users', 'context_get', [], {});
    return result as Context;
  }

  /**
   * Odoo major version from `common.version`, fetched once per client
   * instance and cached. A failed lookup is not cached, so it is retried.
   */
  async serverMajorVersion(): Promise<number> {
    if (!this.serverMajor) {
      this.serverMajor = jsonRpc(this.config.url, JSONRPC, {
        service: 'common',
        method: 'version',
        args: [],
      })
        .then(parseMajorVersion)
        .catch((err: unknown) => {
          this.serverMajor = undefined;
          throw err;
        });
    }
    return this.serverMajor;
  }

  /**
   * Grouped aggregation computed by Odoo (SQL GROUP BY), normalised to the
   * same row shape on every version: formatted_read_group on Odoo 19+,
   * read_group(lazy=False) before. Callers must validate field/aggregate
   * specs; see read-group.ts for the row shape.
   */
  async readGroup(
    model: string,
    request: ReadGroupRequest,
    context?: Context,
  ): Promise<ReadGroupRow[]> {
    this.requireSession();
    const major = await this.serverMajorVersion();
    const { method, args, kwargs } = buildReadGroupCall(major, request, context);
    const rows = await this.executeKw(model, method, args, kwargs);
    return normalizeReadGroupRows(major, request, rows);
  }

  async fieldsGet(
    model: string,
    attributes?: string[],
    context?: Context,
  ): Promise<Record<string, unknown>> {
    const kwargs = compact({ allfields: attributes ?? [], context });
    const result = await this.executeKw(model, 'fields_get', [], kwargs);
    return result as Record<string, unknown>;
  }
}
// Note: capability probing is implemented in @netlinksinc/odoo-mcp's probe.ts
// (the runProbe function) which uses this client's searchRead/contextGet methods.
// An earlier probe() method on OdooClient was removed during v0.1 hardening
// because it duplicated runProbe and was never called from the server path.
