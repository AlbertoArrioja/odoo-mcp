import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OdooError } from '../src/errors.js';
import {
  type ReadGroupRequest,
  buildReadGroupCall,
  normalizeReadGroupRows,
  parseMajorVersion,
} from '../src/read-group.js';

const REQ: ReadGroupRequest = {
  domain: [['state', '=', 'sale']],
  groupby: ['partner_id', 'date_order:month'],
  aggregates: ['amount_total:sum', 'amount_total:avg'],
  orderby: 'amount_total:sum desc, date_order:month asc, __count',
  limit: 11,
};

// Raw rows as each Odoo branch returns them for REQ (shapes taken from the
// 18.0 read_group/_read_group_format_result and 19.0 _web_read_group_format).
const RAW_V19 = [
  {
    partner_id: [7, 'Acme'],
    'date_order:month': ['2026-01-01', 'January 2026'],
    'amount_total:sum': 1500,
    'amount_total:avg': 750,
    __count: 2,
    __extra_domain: ['&', ['partner_id', '=', 7]],
  },
  {
    partner_id: false,
    'date_order:month': false,
    'amount_total:sum': 10,
    'amount_total:avg': 10,
    __count: 1,
    __extra_domain: [],
  },
];

const RAW_V18 = [
  {
    partner_id: [7, 'Acme'],
    'date_order:month': 'January 2026',
    amount_total__sum: 1500,
    amount_total__avg: 750,
    __count: 2,
    __range: { 'date_order:month': { from: '2026-01-01', to: '2026-02-01' } },
    __domain: [],
  },
  {
    partner_id: false,
    'date_order:month': false,
    amount_total__sum: 10,
    amount_total__avg: 10,
    __count: 1,
    __range: { 'date_order:month': false },
    __domain: [],
  },
];

const EXPECTED = [
  {
    partner_id: [7, 'Acme'],
    'date_order:month': { value: '2026-01-01', label: 'January 2026' },
    'amount_total:sum': 1500,
    'amount_total:avg': 750,
    __count: 2,
  },
  {
    partner_id: false,
    'date_order:month': false,
    'amount_total:sum': 10,
    'amount_total:avg': 10,
    __count: 1,
  },
];

describe('parseMajorVersion', () => {
  it('reads a numeric server_version_info[0]', () => {
    expect(parseMajorVersion({ server_version_info: [19, 0, 0, 'final', 0, ''] })).toBe(19);
  });

  it('reads saas-style ids', () => {
    expect(parseMajorVersion({ server_version_info: ['saas~18', 4, 0, 'final', 0, ''] })).toBe(18);
  });

  it('falls back to server_version', () => {
    expect(parseMajorVersion({ server_version: '17.0+e' })).toBe(17);
  });

  it('throws on an unrecognisable response', () => {
    expect(() => parseMajorVersion({})).toThrow(OdooError);
    expect(() => parseMajorVersion(null)).toThrow(OdooError);
  });
});

describe('buildReadGroupCall', () => {
  it('Odoo 19+: formatted_read_group with specs as-is and __count appended', () => {
    const ctx = { uid: 7 };
    expect(buildReadGroupCall(19, REQ, ctx)).toEqual({
      method: 'formatted_read_group',
      args: [REQ.domain],
      kwargs: {
        groupby: ['partner_id', 'date_order:month'],
        aggregates: ['amount_total:sum', 'amount_total:avg', '__count'],
        order: 'amount_total:sum desc, date_order:month asc, __count',
        limit: 11,
        context: ctx,
      },
    });
  });

  it('Odoo ≤ 18: read_group lazy=False with aliased aggregates and translated orderby', () => {
    expect(buildReadGroupCall(18, REQ)).toEqual({
      method: 'read_group',
      args: [REQ.domain],
      kwargs: {
        fields: ['amount_total__sum:sum(amount_total)', 'amount_total__avg:avg(amount_total)'],
        groupby: ['partner_id', 'date_order:month'],
        lazy: false,
        orderby: 'amount_total__sum desc, date_order asc, __count',
        limit: 11,
      },
    });
  });

  it('omits order/limit/context when not given', () => {
    const req = { domain: [], groupby: ['state'], aggregates: [] };
    expect(buildReadGroupCall(19, req).kwargs).toEqual({
      groupby: ['state'],
      aggregates: ['__count'],
    });
    expect(buildReadGroupCall(17, req).kwargs).toEqual({
      fields: [],
      groupby: ['state'],
      lazy: false,
    });
  });
});

describe('normalizeReadGroupRows', () => {
  it('Odoo 19 rows normalise to the common shape', () => {
    expect(normalizeReadGroupRows(19, REQ, RAW_V19)).toEqual(EXPECTED);
  });

  it('Odoo 18 rows normalise to the SAME shape', () => {
    expect(normalizeReadGroupRows(18, REQ, RAW_V18)).toEqual(EXPECTED);
  });

  it('missing aggregate values become null and missing count becomes 0', () => {
    const req = { domain: [], groupby: [], aggregates: ['amount_total:sum'] };
    expect(normalizeReadGroupRows(19, req, [{}])).toEqual([
      { 'amount_total:sum': null, __count: 0 },
    ]);
  });

  it('throws on a non-array response', () => {
    expect(() => normalizeReadGroupRows(19, REQ, { error: 'x' })).toThrow(OdooError);
  });
});

// ---------------------------------------------------------------------------
// OdooClient.readGroup — version detected once per client
// ---------------------------------------------------------------------------

vi.mock('../src/rpc.js', () => ({ jsonRpc: vi.fn() }));
vi.mock('../src/auth.js', () => ({ createAuthStrategy: vi.fn() }));

import { jsonRpc } from '../src/rpc.js';
import { createAuthStrategy } from '../src/auth.js';
import { OdooClient } from '../src/client.js';

const mockJsonRpc = jsonRpc as unknown as ReturnType<typeof vi.fn>;

async function client(): Promise<OdooClient> {
  (createAuthStrategy as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    authenticate: vi
      .fn()
      .mockResolvedValue({ uid: 7, companyId: 1, allowedCompanyIds: [1], userContext: {} }),
    applyAuth: vi.fn(),
  });
  const c = new OdooClient({
    url: 'https://odoo.example.test',
    db: 'testdb',
    username: 'user@example.test',
    apiKey: 'placeholder-key',
  });
  await c.authenticate();
  return c;
}

/** Fake Odoo: answers common.version with `major`, execute_kw with `rows`. */
function fakeOdoo(major: number, rows: unknown) {
  mockJsonRpc.mockImplementation(async (_url: string, _ep: string, params: { service: string }) =>
    params.service === 'common' ? { server_version_info: [major, 0, 0, 'final', 0, ''] } : rows,
  );
}

const versionCalls = () =>
  mockJsonRpc.mock.calls.filter((c) => (c[2] as { service: string }).service === 'common').length;

describe('OdooClient.readGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses formatted_read_group on Odoo 19 and normalises', async () => {
    const c = await client();
    fakeOdoo(19, RAW_V19);
    await expect(c.readGroup('sale.order', REQ)).resolves.toEqual(EXPECTED);
    const call = mockJsonRpc.mock.calls.find((x) => x[2].service === 'object');
    expect(call?.[2].args.slice(3, 5)).toEqual(['sale.order', 'formatted_read_group']);
  });

  it('uses read_group on Odoo 18 and normalises to the same result', async () => {
    const c = await client();
    fakeOdoo(18, RAW_V18);
    await expect(c.readGroup('sale.order', REQ)).resolves.toEqual(EXPECTED);
    const call = mockJsonRpc.mock.calls.find((x) => x[2].service === 'object');
    expect(call?.[2].args.slice(3, 5)).toEqual(['sale.order', 'read_group']);
  });

  it('calls common.version only once per client across calls', async () => {
    const c = await client();
    fakeOdoo(19, RAW_V19);
    await c.readGroup('sale.order', REQ);
    await c.readGroup('sale.order', REQ);
    await c.serverMajorVersion();
    expect(versionCalls()).toBe(1);
  });

  it('does not cache a failed version lookup', async () => {
    const c = await client();
    mockJsonRpc.mockRejectedValueOnce(new Error('network down'));
    await expect(c.serverMajorVersion()).rejects.toThrow('network down');
    fakeOdoo(19, []);
    await expect(c.serverMajorVersion()).resolves.toBe(19);
  });

  it('requires an authenticated session', async () => {
    const c = new OdooClient({ url: 'https://x.test', db: 'd', username: 'u', apiKey: 'k' });
    await expect(c.readGroup('sale.order', REQ)).rejects.toThrow('Not authenticated');
    expect(mockJsonRpc).not.toHaveBeenCalled();
  });
});
