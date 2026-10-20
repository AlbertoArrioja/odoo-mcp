import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OdooClient, type OdooSession } from '@netlinksinc/odoo-client';
import type { Logger } from '../../src/logger.js';
import type { ClientResolver } from '../../src/types.js';
import { registerReadGroupTool } from '../../src/tools/read-group.js';

// ---------------------------------------------------------------------------
// The tool runs against a REAL OdooClient whose transport (global fetch) is a
// simulated Odoo. That exercises tool → per-user client → jsonRpc allowlist →
// wire format, and lets us assert which user's API key each request carried.
// All URLs/keys are placeholders.
// ---------------------------------------------------------------------------

vi.mock('../../src/http-transport.js', () => ({
  requestContextStorage: { getStore: () => undefined },
}));

const ODOO_URL = 'https://odoo.example.test';
const ALLOWED = ['sale.order', 'account.move'];

const USERS: Record<string, { uid: number; apiKey: string }> = {
  'ana@example.test': { uid: 11, apiKey: 'placeholder-key-ana' },
  'luis@example.test': { uid: 22, apiKey: 'placeholder-key-luis' },
};

interface ExecuteKwCall {
  uid: number;
  apiKey: string;
  model: string;
  method: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
}

/** Simulated Odoo answering over /jsonrpc. */
function makeFakeOdoo(major: number, groupRows: unknown[]) {
  const executeKwCalls: ExecuteKwCall[] = [];
  let versionCalls = 0;

  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as {
      params: { service: string; method: string; args: unknown[] };
    };
    let result: unknown;
    if (params.service === 'common' && params.method === 'version') {
      versionCalls++;
      result = { server_version: `${major}.0`, server_version_info: [major, 0, 0, 'final', 0, ''] };
    } else if (params.service === 'common' && params.method === 'authenticate') {
      const [, login, key] = params.args as [string, string, string];
      const user = USERS[login];
      result = user && user.apiKey === key ? user.uid : false;
    } else {
      const [, uid, apiKey, model, method, args, kwargs] = params.args as [
        string,
        number,
        string,
        string,
        string,
        unknown[],
        Record<string, unknown>,
      ];
      executeKwCalls.push({ uid, apiKey, model, method, args, kwargs });
      if (method === 'read') result = [{ company_id: [1, 'Main'], company_ids: [1, 2] }];
      else if (method === 'context_get') result = { lang: 'es_MX', tz: 'America/Mexico_City' };
      else result = groupRows;
    }
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  });

  return {
    fetchMock,
    executeKwCalls,
    groupCalls: () =>
      executeKwCalls.filter((c) => c.method === 'formatted_read_group' || c.method === 'read_group'),
    versionCalls: () => versionCalls,
  };
}

/** Per-user resolver, like bin.ts: one authenticated OdooClient per email. */
function makeResolver() {
  let current = 'ana@example.test';
  const cache = new Map<string, { client: OdooClient; session: OdooSession }>();
  const resolver = vi.fn<ClientResolver>(async () => {
    const cached = cache.get(current);
    if (cached) return cached;
    const client = new OdooClient({
      url: ODOO_URL,
      db: 'testdb',
      username: current,
      apiKey: USERS[current].apiKey,
    });
    const session = await client.authenticate();
    const entry = { client, session };
    cache.set(current, entry);
    return entry;
  });
  return {
    resolver,
    actAs: (email: string) => {
      current = email;
    },
  };
}

function makeLoggerMock(): Logger {
  return { toolCall: vi.fn(), startup: vi.fn(), shutdown: vi.fn() };
}

type Handler = (args: unknown) => Promise<{ isError: boolean; content: Array<{ text: string }> }>;

function register(allowedModels: readonly string[], resolver: ClientResolver, logger: Logger) {
  let handler: Handler | undefined;
  let description = '';
  const server = {
    registerTool: vi.fn((_name: string, cfg: { description: string }, cb: Handler) => {
      handler = cb;
      description = cfg.description;
    }),
  };
  registerReadGroupTool(server as never, resolver, logger, allowedModels);
  return { call: (args: unknown) => (handler as Handler)(args), description };
}

const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

// Equivalent raw rows for both branches (see odoo-client read-group tests).
const ROWS_V19 = [
  {
    user_id: [5, 'Ana'],
    'date_order:month': ['2026-01-01', 'enero 2026'],
    'amount_total:sum': 1500,
    __count: 3,
    __extra_domain: [],
  },
];
const ROWS_V18 = [
  {
    user_id: [5, 'Ana'],
    'date_order:month': 'enero 2026',
    amount_total__sum: 1500,
    __count: 3,
    __range: { 'date_order:month': { from: '2026-01-01', to: '2026-02-01' } },
    __domain: [],
  },
];
const NORMALISED = {
  groups: [
    {
      user_id: [5, 'Ana'],
      'date_order:month': { value: '2026-01-01', label: 'enero 2026' },
      'amount_total:sum': 1500,
      __count: 3,
    },
  ],
  has_more: false,
};

const VALID = {
  model: 'sale.order',
  domain: [['state', '=', 'sale']],
  groupby: ['user_id', 'date_order:month'],
  aggregates: ['amount_total:sum'],
};

let logger: Logger;

beforeEach(() => {
  logger = makeLoggerMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Version branches
// ---------------------------------------------------------------------------

describe('odoo_read_group — version branches', () => {
  it('Odoo 19: calls formatted_read_group and returns the normalised shape', async () => {
    const odoo = makeFakeOdoo(19, ROWS_V19);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const { resolver } = makeResolver();
    const tool = register(ALLOWED, resolver, logger);

    const res = await tool.call(VALID);

    expect(res.isError).toBe(false);
    expect(payload(res)).toEqual(NORMALISED);
    const [call] = odoo.groupCalls();
    expect(call.method).toBe('formatted_read_group');
    expect(call.args).toEqual([VALID.domain]);
    expect(call.kwargs).toMatchObject({
      groupby: VALID.groupby,
      aggregates: ['amount_total:sum', '__count'],
      limit: 81,
    });
  });

  it('Odoo 18: calls read_group lazy=False and returns the SAME shape', async () => {
    const odoo = makeFakeOdoo(18, ROWS_V18);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const { resolver } = makeResolver();
    const tool = register(ALLOWED, resolver, logger);

    const res = await tool.call(VALID);

    expect(res.isError).toBe(false);
    expect(payload(res)).toEqual(NORMALISED);
    const [call] = odoo.groupCalls();
    expect(call.method).toBe('read_group');
    expect(call.kwargs).toMatchObject({
      fields: ['amount_total__sum:sum(amount_total)'],
      groupby: VALID.groupby,
      lazy: false,
    });
  });

  it('detects the version once per session (client), not per call', async () => {
    const odoo = makeFakeOdoo(19, ROWS_V19);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const { resolver } = makeResolver();
    const tool = register(ALLOWED, resolver, logger);

    await tool.call(VALID);
    await tool.call(VALID);
    await tool.call({ ...VALID, groupby: [] });

    expect(odoo.versionCalls()).toBe(1);
  });

  it('omitting aggregates returns only __count per group', async () => {
    const odoo = makeFakeOdoo(19, [{ state: 'sale', __count: 4, __extra_domain: [] }]);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const tool = register(ALLOWED, makeResolver().resolver, logger);

    const res = await tool.call({ model: 'sale.order', groupby: ['state'] });

    expect(payload(res)).toEqual({ groups: [{ state: 'sale', __count: 4 }], has_more: false });
    expect(odoo.groupCalls()[0].kwargs.aggregates).toEqual(['__count']);
  });

  it('requests limit+1 and reports has_more without returning the extra group', async () => {
    const rows = [1, 2, 3].map((n) => ({ state: `s${n}`, __count: n, __extra_domain: [] }));
    const odoo = makeFakeOdoo(19, rows);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const tool = register(ALLOWED, makeResolver().resolver, logger);

    const res = await tool.call({ model: 'sale.order', groupby: ['state'], limit: 2 });

    expect(odoo.groupCalls()[0].kwargs.limit).toBe(3);
    const body = payload(res);
    expect(body.groups).toHaveLength(2);
    expect(body.has_more).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-user credentials
// ---------------------------------------------------------------------------

describe('odoo_read_group — runs with the session user’s client', () => {
  it('each call carries the uid and API key of the user who made it', async () => {
    const odoo = makeFakeOdoo(19, ROWS_V19);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const { resolver, actAs } = makeResolver();
    const tool = register(ALLOWED, resolver, logger);

    actAs('ana@example.test');
    await tool.call(VALID);
    actAs('luis@example.test');
    await tool.call(VALID);

    const [anaCall, luisCall] = odoo.groupCalls();
    expect(anaCall).toMatchObject({ uid: 11, apiKey: 'placeholder-key-ana' });
    expect(luisCall).toMatchObject({ uid: 22, apiKey: 'placeholder-key-luis' });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('passes the session context (uid, companies) to Odoo', async () => {
    const odoo = makeFakeOdoo(19, ROWS_V19);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const tool = register(ALLOWED, makeResolver().resolver, logger);

    await tool.call({ ...VALID, allowed_company_ids: [2], active_company_id: 2 });

    expect(odoo.groupCalls()[0].kwargs.context).toMatchObject({
      uid: 11,
      allowed_company_ids: [2],
      company_id: 2,
      tz: 'America/Mexico_City',
    });
  });

  it('rejects companies outside the session user’s allowed set', async () => {
    const odoo = makeFakeOdoo(19, ROWS_V19);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const tool = register(ALLOWED, makeResolver().resolver, logger);

    const res = await tool.call({ ...VALID, allowed_company_ids: [99] });

    expect(res.isError).toBe(true);
    expect(payload(res).error_type).toBe('InputValidationError');
    expect(odoo.groupCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Model allowlist (ODOO_MCP_AGGREGATE_MODELS)
// ---------------------------------------------------------------------------

describe('odoo_read_group — model allowlist', () => {
  it('rejects a model outside the allowlist without touching Odoo', async () => {
    const odoo = makeFakeOdoo(19, ROWS_V19);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const { resolver } = makeResolver();
    const tool = register(ALLOWED, resolver, logger);

    const res = await tool.call({ ...VALID, model: 'hr.employee' });

    expect(res.isError).toBe(true);
    expect(payload(res).error_type).toBe('InputValidationError');
    expect(payload(res).message).toContain('hr.employee');
    expect(resolver).not.toHaveBeenCalled();
    expect(odoo.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects every call when ODOO_MCP_AGGREGATE_MODELS is not set (empty list)', async () => {
    const odoo = makeFakeOdoo(19, ROWS_V19);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const { resolver } = makeResolver();
    const tool = register([], resolver, logger);

    for (const model of ['sale.order', 'account.move', 'res.partner']) {
      const res = await tool.call({ ...VALID, model });
      expect(res.isError).toBe(true);
      expect(payload(res).message).toContain('ODOO_MCP_AGGREGATE_MODELS');
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(odoo.fetchMock).not.toHaveBeenCalled();
    expect(tool.description).toContain('DISABLED');
  });

  it('description steers Claude to prefer it over odoo_search_read and lists enabled models', () => {
    const tool = register(ALLOWED, makeResolver().resolver, logger);
    expect(tool.description).toContain('PREFER THIS over odoo_search_read');
    for (const word of ['totals', 'counts', 'averages']) {
      expect(tool.description).toContain(word);
    }
    expect(tool.description).toContain('sale.order, account.move');
  });
});

// ---------------------------------------------------------------------------
// Strict input validation — nothing invalid may reach the resolver or Odoo
// ---------------------------------------------------------------------------

describe('odoo_read_group — input validation', () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['uppercase model', { model: 'Sale.Order' }],
    ['model with injection', { model: 'sale.order;drop' }],
    ['missing groupby', { groupby: undefined }],
    ['groupby with uppercase field', { groupby: ['User_id'] }],
    ['groupby related path', { groupby: ['partner_id.country_id'] }],
    ['groupby leading underscore', { groupby: ['__count'] }],
    ['groupby unsupported granularity', { groupby: ['date_order:hour'] }],
    ['groupby number granularity', { groupby: ['date_order:month_number'] }],
    ['groupby duplicates', { groupby: ['user_id', 'user_id'] }],
    ['aggregate without function', { aggregates: ['amount_total'] }],
    ['aggregate unknown function', { aggregates: ['amount_total:median'] }],
    ['aggregate array_agg', { aggregates: ['id:array_agg'] }],
    ['aggregate recordset', { aggregates: ['order_line:recordset'] }],
    ['aggregate alias syntax', { aggregates: ['total:sum(amount_total)'] }],
    ['aggregate sql injection', { aggregates: ['amount_total:sum) FROM res_users --'] }],
    ['aggregate duplicates', { aggregates: ['amount_total:sum', 'amount_total:sum'] }],
    ['orderby unknown key', { orderby: 'name desc' }],
    ['orderby injection', { orderby: 'amount_total:sum desc; DROP TABLE x' }],
    ['orderby bad direction', { orderby: 'amount_total:sum sideways' }],
    ['orderby nulls clause', { orderby: 'amount_total:sum desc nulls last' }],
    ['orderby empty term', { orderby: 'amount_total:sum,,__count' }],
    ['limit above 500', { limit: 501 }],
    ['limit zero', { limit: 0 }],
    ['limit fractional', { limit: 1.5 }],
    ['too many groupbys', { groupby: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  ];

  it.each(invalid)('rejects %s', async (_label, override) => {
    const odoo = makeFakeOdoo(19, ROWS_V19);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const { resolver } = makeResolver();
    const tool = register(ALLOWED, resolver, logger);

    const res = await tool.call({ ...VALID, ...override });

    expect(res.isError).toBe(true);
    expect(payload(res).error_type).toBe('InputValidationError');
    expect(resolver).not.toHaveBeenCalled();
    expect(odoo.fetchMock).not.toHaveBeenCalled();
    expect(logger.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_read_group', error: 'InputValidationError' }),
    );
  });

  it.each([
    ['empty groupby (overall total)', { groupby: [] }],
    ['all granularities', { groupby: ['date_order:day', 'create_date:week', 'x:quarter'] }],
    [
      'every allowed aggregate',
      {
        aggregates: [
          'amount_total:sum',
          'amount_total:avg',
          'amount_total:min',
          'amount_total:max',
          'id:count',
          'partner_id:count_distinct',
        ],
      },
    ],
    ['orderby on groupby, aggregate and __count', { orderby: 'date_order:month asc, amount_total:sum desc, __count' }],
    ['limit 500', { limit: 500 }],
  ])('accepts %s', async (_label, override) => {
    const odoo = makeFakeOdoo(19, []);
    vi.stubGlobal('fetch', odoo.fetchMock);
    const tool = register(ALLOWED, makeResolver().resolver, logger);

    const res = await tool.call({ ...VALID, ...override });

    expect(res.isError).toBe(false);
    expect(odoo.groupCalls()).toHaveLength(1);
  });
});
