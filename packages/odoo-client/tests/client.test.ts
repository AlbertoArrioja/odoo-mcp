import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OdooClient } from '../src/client.js';
import { OdooAuthError } from '../src/errors.js';
import type { OdooConfig, OdooSession } from '../src/types.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../src/rpc.js', () => ({ jsonRpc: vi.fn() }));
vi.mock('../src/auth.js', () => ({ createAuthStrategy: vi.fn() }));

// Import the mocked functions AFTER vi.mock declarations
import { jsonRpc } from '../src/rpc.js';
import { createAuthStrategy } from '../src/auth.js';

const mockJsonRpc = jsonRpc as unknown as ReturnType<typeof vi.fn>;
const mockCreateAuthStrategy = createAuthStrategy as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures — placeholder values only, never real credentials.
// ---------------------------------------------------------------------------

const CONFIG: OdooConfig = {
  url: 'https://odoo.example.test',
  db: 'testdb',
  username: 'user@example.test',
  apiKey: 'placeholder-key',
};

const SESSION: OdooSession = {
  uid: 7,
  companyId: 1,
  allowedCompanyIds: [1],
  userContext: { lang: 'en_US', tz: 'UTC' },
};

function makeStrategy(session: OdooSession = SESSION) {
  return {
    authenticate: vi.fn().mockResolvedValue(session),
    applyAuth: vi.fn((r: unknown) => r),
  };
}

async function authenticatedClient(session: OdooSession = SESSION): Promise<OdooClient> {
  mockCreateAuthStrategy.mockResolvedValue(makeStrategy(session));
  const client = new OdooClient(CONFIG);
  await client.authenticate();
  return client;
}

/** The `params` object passed to the Nth jsonRpc call. */
function rpcParams(n = 0): { service: string; method: string; args: unknown[] } {
  return mockJsonRpc.mock.calls[n][2] as { service: string; method: string; args: unknown[] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OdooClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('authenticate() returns the OdooSession from the strategy', async () => {
    mockCreateAuthStrategy.mockResolvedValue(makeStrategy());
    const client = new OdooClient(CONFIG);
    await expect(client.authenticate()).resolves.toEqual(SESSION);
  });

  it('searchRead() throws OdooAuthError when not authenticated', async () => {
    const client = new OdooClient(CONFIG);
    await expect(client.searchRead('res.partner', [])).rejects.toThrow(OdooAuthError);
    expect(mockJsonRpc).not.toHaveBeenCalled();
  });

  it('searchRead() sends object.execute_kw search_read with default limit=80', async () => {
    const client = await authenticatedClient();
    mockJsonRpc.mockResolvedValue([{ id: 1 }]);

    await client.searchRead('res.partner', [['active', '=', true]], ['name']);

    expect(mockJsonRpc).toHaveBeenCalledWith(CONFIG.url, '/jsonrpc', {
      service: 'object',
      method: 'execute_kw',
      args: [
        CONFIG.db,
        SESSION.uid,
        CONFIG.apiKey,
        'res.partner',
        'search_read',
        [[['active', '=', true]]],
        { fields: ['name'], limit: 80 },
      ],
    });
  });

  it('read() sends read with ids and fields', async () => {
    const client = await authenticatedClient();
    mockJsonRpc.mockResolvedValue([{ id: 3 }]);

    await client.read('res.partner', [3], ['name']);

    const { args } = rpcParams();
    expect(args.slice(3)).toEqual(['res.partner', 'read', [[3]], { fields: ['name'] }]);
  });

  it('searchCount() sends search_count and returns the number', async () => {
    const client = await authenticatedClient();
    mockJsonRpc.mockResolvedValue(12);

    await expect(client.searchCount('res.partner', [])).resolves.toBe(12);
    expect(rpcParams().args[4]).toBe('search_count');
  });

  it('contextGet() sends res.users.context_get', async () => {
    const client = await authenticatedClient();
    mockJsonRpc.mockResolvedValue({ lang: 'es_MX', tz: 'America/Mexico_City' });

    await expect(client.contextGet()).resolves.toEqual({
      lang: 'es_MX',
      tz: 'America/Mexico_City',
    });
    expect(rpcParams().args.slice(3, 5)).toEqual(['res.users', 'context_get']);
  });

  it('fieldsGet() sends fields_get with allfields kwarg', async () => {
    const client = await authenticatedClient();
    mockJsonRpc.mockResolvedValue({});

    await client.fieldsGet('res.partner', ['string', 'type']);

    expect(rpcParams().args.slice(3)).toEqual([
      'res.partner',
      'fields_get',
      [],
      { allfields: ['string', 'type'] },
    ]);
  });
});

describe('OdooClient — read-only surface', () => {
  it('does not expose any write or arbitrary-method API', () => {
    const proto = OdooClient.prototype as unknown as Record<string, unknown>;
    for (const removed of ['create', 'write', 'unlink', 'execute', 'callAction', 'runReport']) {
      expect(proto[removed]).toBeUndefined();
    }
  });
});
