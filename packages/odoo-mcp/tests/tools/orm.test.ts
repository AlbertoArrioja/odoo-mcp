import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OdooSession } from '@netlinksinc/odoo-client';
import { OdooAccessError, OdooError } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';
import type { Logger } from '../../src/logger.js';
import type { ClientResolver } from '../../src/types.js';
import { registerOrmTools } from '../../src/tools/orm.js';

// ---------------------------------------------------------------------------
// Mock http-transport to prevent side-effects during tests
// ---------------------------------------------------------------------------

vi.mock('../../src/http-transport.js', () => ({
  requestContextStorage: {
    getStore: () => undefined,
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION: OdooSession = {
  uid: 1,
  companyId: 1,
  allowedCompanyIds: [1, 2],
  userContext: { lang: 'en_US' },
};

function makeClientMock() {
  return {
    searchRead: vi.fn().mockResolvedValue([{ id: 1, name: 'Acme' }]),
    read: vi.fn().mockResolvedValue([{ id: 1, name: 'Acme' }]),
    searchCount: vi.fn().mockResolvedValue(7),
  } as unknown as OdooClient;
}

function makeLoggerMock(): Logger {
  return {
    toolCall: vi.fn(),
    startup: vi.fn(),
    shutdown: vi.fn(),
  };
}

/**
 * Server mock that stores each handler by tool name.
 * Uses the 3-arg registerTool(name, schema, handler) form.
 */
function makeServerMock() {
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
  return {
    handlers,
    registerTool: vi.fn(
      (name: string, _schema: unknown, cb: (args: unknown) => Promise<unknown>) => {
        handlers[name] = cb;
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let serverMock: ReturnType<typeof makeServerMock>;
let clientMock: OdooClient;
let loggerMock: Logger;
let mockResolver: ClientResolver;

beforeEach(() => {
  serverMock = makeServerMock();
  clientMock = makeClientMock();
  loggerMock = makeLoggerMock();
  mockResolver = async () => ({ client: clientMock, session: SESSION });
  registerOrmTools(serverMock as never, mockResolver, loggerMock);
});

// ---------------------------------------------------------------------------
// Registration sanity
// ---------------------------------------------------------------------------

describe('tool registration', () => {
  it('registers exactly 3 read-only tools', () => {
    expect(serverMock.registerTool).toHaveBeenCalledTimes(3);
  });

  it('registers the expected tool names', () => {
    const names = (serverMock.registerTool as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(names).toEqual(['odoo_search_read', 'odoo_read', 'odoo_search_count']);
  });
});

// ---------------------------------------------------------------------------
// AC-1: odoo_search_read happy path
// ---------------------------------------------------------------------------

describe('AC-1: odoo_search_read — valid call', () => {
  it('passes model, domain, fields, limit, offset, context to client.searchRead', async () => {
    const response = (await serverMock.handlers['odoo_search_read']({
      model: 'res.partner',
      fields: ['name'],
      limit: 10,
    })) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(clientMock.searchRead).toHaveBeenCalledOnce();
    const [model, domain, fields, opts] = (
      clientMock.searchRead as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(model).toBe('res.partner');
    expect(domain).toEqual([]);
    expect(fields).toEqual(['name']);
    expect(opts.limit).toBe(10);
    expect(opts.offset).toBe(0);
    expect(opts.context).toMatchObject({
      uid: 1,
      company_id: 1,
      allowed_company_ids: [1, 2],
    });

    expect(response.isError).toBe(false);
    expect(JSON.parse(response.content[0].text)).toEqual([{ id: 1, name: 'Acme' }]);
  });

  it('logs toolCall with status ok on success', async () => {
    await serverMock.handlers['odoo_search_read']({
      model: 'res.partner',
      fields: ['name'],
    });
    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_search_read', status: 'ok' }),
    );
  });
});

// ---------------------------------------------------------------------------
// AC-2: missing model → InputValidationError, no client call
// ---------------------------------------------------------------------------

describe('AC-2: odoo_search_read — missing model', () => {
  it('returns isError:true with error_type InputValidationError', async () => {
    const response = (await serverMock.handlers['odoo_search_read']({
      fields: ['name'],
    })) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
  });

  it('does NOT call client.searchRead when model is missing', async () => {
    await serverMock.handlers['odoo_search_read']({ fields: ['name'] });
    expect(clientMock.searchRead).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-4: allowed_company_ids not in session → InputValidationError, no client call
// ---------------------------------------------------------------------------

describe('AC-4: company subset validation', () => {
  it('returns isError:true when allowed_company_ids contains 999 not in session [1,2]', async () => {
    const response = (await serverMock.handlers['odoo_search_read']({
      model: 'res.partner',
      allowed_company_ids: [999],
    })) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
  });

  it('does NOT call client.searchRead when company subset is invalid', async () => {
    await serverMock.handlers['odoo_search_read']({
      model: 'res.partner',
      allowed_company_ids: [999],
    });
    expect(clientMock.searchRead).not.toHaveBeenCalled();
  });

  it('allows a valid subset of session allowedCompanyIds', async () => {
    const response = (await serverMock.handlers['odoo_search_read']({
      model: 'res.partner',
      allowed_company_ids: [1],
    })) as { isError: boolean };
    expect(response.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-5: client.searchRead throwing OdooAccessError → isError:true + AccessError
// ---------------------------------------------------------------------------

describe('AC-5: OdooAccessError from client', () => {
  it('returns isError:true with error_type AccessError', async () => {
    (clientMock.searchRead as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooAccessError('Access denied to res.partner', 'res.partner', 'search_read'),
    );

    const response = (await serverMock.handlers['odoo_search_read']({
      model: 'res.partner',
      fields: ['name'],
    })) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('AccessError');
    expect(payload.message).toBe('Access denied to res.partner');
  });

  it('logs toolCall with status error when OdooAccessError is thrown', async () => {
    (clientMock.searchRead as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooAccessError('denied'),
    );
    await serverMock.handlers['odoo_search_read']({ model: 'res.partner' });
    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'AccessError' }),
    );
  });
});

// ---------------------------------------------------------------------------
// odoo_read happy path
// ---------------------------------------------------------------------------

describe('odoo_read — valid call', () => {
  it('calls client.read with model, ids, fields, context', async () => {
    const response = (await serverMock.handlers['odoo_read']({
      model: 'res.partner',
      ids: [1, 2],
      fields: ['name', 'email'],
    })) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(clientMock.read).toHaveBeenCalledOnce();
    const [model, ids, fields, context] = (
      clientMock.read as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(model).toBe('res.partner');
    expect(ids).toEqual([1, 2]);
    expect(fields).toEqual(['name', 'email']);
    expect(context).toMatchObject({ uid: 1 });
    expect(response.isError).toBe(false);
  });

  it('returns isError:true when ids is missing', async () => {
    const response = (await serverMock.handlers['odoo_read']({ model: 'res.partner' })) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
    expect(clientMock.read).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// odoo_search_count happy path
// ---------------------------------------------------------------------------

describe('odoo_search_count — valid call', () => {
  it('calls client.searchCount and returns count', async () => {
    const response = (await serverMock.handlers['odoo_search_count']({
      model: 'res.partner',
      domain: [['active', '=', true]],
    })) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(clientMock.searchCount).toHaveBeenCalledOnce();
    const [model, domain, context] = (
      clientMock.searchCount as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(model).toBe('res.partner');
    expect(domain).toEqual([['active', '=', true]]);
    expect(context).toMatchObject({ uid: 1 });
    expect(response.isError).toBe(false);
    expect(JSON.parse(response.content[0].text)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// F-005: non-OdooError caught + logged + returns isError with InternalError
// ---------------------------------------------------------------------------

describe('non-OdooError caught and returned as InternalError (F-005)', () => {
  it('catches TypeError from client.searchRead and returns isError:true with InternalError', async () => {
    (clientMock.searchRead as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('network failure'),
    );

    const response = (await serverMock.handlers['odoo_search_read']({
      model: 'res.partner',
    })) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InternalError');
    expect(payload.message).toBe('An internal error occurred');
    // Raw error message is NOT sent to client (security: no internal-path leakage).
    expect(payload.detail).toBeUndefined();
  });

  it('logs toolCall with status error and InternalError on non-OdooError', async () => {
    (clientMock.searchRead as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('network failure'),
    );

    await serverMock.handlers['odoo_search_read']({ model: 'res.partner' });

    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'InternalError' }),
    );
  });
});

// ---------------------------------------------------------------------------
// ClientResolver: OdooAuthError propagates out of handler
// ---------------------------------------------------------------------------

describe('ClientResolver error propagation', () => {
  it('propagates rejection from clientResolver without catching', async () => {
    const authError = new Error('OdooAuthError: session expired');
    const failingResolver: ClientResolver = async () => {
      throw authError;
    };
    const failServerMock = makeServerMock();
    registerOrmTools(failServerMock as never, failingResolver, loggerMock);

    await expect(
      failServerMock.handlers['odoo_search_read']({ model: 'res.partner' }),
    ).rejects.toThrow('OdooAuthError: session expired');
  });
});
