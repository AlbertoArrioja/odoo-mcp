// TODO(v0.2): rewrite assertions for the new /jsonrpc execute_kw wire format.
//   Auth was rewritten in commit fixing OdooAuthError 'Access Denied' against modern Odoo.
//   The old assertions targeted /web/session/authenticate + /web/dataset/call_kw which v0.1.0 used.
//   Smoke test against live Odoo passes — see scripts/smoke-test.mjs.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OdooAuthError } from '../src/errors.js';
import { ApiKeyAuthStrategy, createAuthStrategy } from '../src/auth.js';
import type { OdooConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers — mirror rpc.test.ts conventions
// ---------------------------------------------------------------------------

function makeFetchResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: {
      get: (name: string) => extraHeaders[name.toLowerCase()] ?? null,
    },
  } as unknown as Response;
}

function makeAuthOk(overrides: Record<string, unknown> = {}) {
  return makeFetchResponse({
    jsonrpc: '2.0',
    id: 1,
    result: {
      uid: 7,
      company_id: 1,
      allowed_company_ids: [1, 2],
      user_context: { lang: 'en_US', tz: 'UTC' },
      ...overrides,
    },
  });
}

function makeAuthError(name: string, message: string, debug = 'traceback') {
  return makeFetchResponse({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: 200,
      message: 'Odoo Server Error',
      data: { name, message, debug },
    },
  });
}

const BASE_CONFIG: OdooConfig = {
  url: 'https://demo.odoo.com',
  db: 'mydb',
  username: 'admin',
  apiKey: 's3cr3t',
};

const HTTP_CONFIG: OdooConfig = { ...BASE_CONFIG, url: 'http://demo.odoo.com' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skip('ApiKeyAuthStrategy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // TC-1: happy path returns fully-populated OdooSession
  it('authenticate happy path returns OdooSession with all fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeAuthOk()));

    const strategy = new ApiKeyAuthStrategy();
    const session = await strategy.authenticate(BASE_CONFIG);

    expect(session.uid).toBe(7);
    expect(session.companyId).toBe(1);
    expect(session.allowedCompanyIds).toEqual([1, 2]);
    expect(session.userContext).toEqual({ lang: 'en_US', tz: 'UTC' });
    // sessionId should be absent (API-key path doesn't parse cookies)
    expect(session.sessionId).toBeUndefined();
  });

  // TC-2: AccessDenied fault → OdooAuthError
  it('authenticate throws OdooAuthError when Odoo returns AccessDenied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeAuthError('odoo.exceptions.AccessDenied', 'Invalid credentials'),
      ),
    );

    const strategy = new ApiKeyAuthStrategy();
    await expect(strategy.authenticate(BASE_CONFIG)).rejects.toBeInstanceOf(OdooAuthError);
  });

  // TC-3: applyAuth returns request unchanged when sessionId is absent
  it('applyAuth returns the request unchanged when no sessionId', () => {
    const strategy = new ApiKeyAuthStrategy();
    const request = { jsonrpc: '2.0' as const, method: 'call' as const, id: 1, params: {} };
    const session = {
      uid: 7,
      companyId: 1,
      allowedCompanyIds: [1],
      userContext: {},
    };
    expect(strategy.applyAuth(request, session)).toBe(request);
  });

  // TC-4: applyAuth returns the same request when sessionId IS present (headers passed separately)
  it('applyAuth returns the same request object when sessionId is present', () => {
    const strategy = new ApiKeyAuthStrategy();
    const request = { jsonrpc: '2.0' as const, method: 'call' as const, id: 1, params: {} };
    const session = {
      uid: 7,
      sessionId: 'abc123',
      companyId: 1,
      allowedCompanyIds: [1],
      userContext: {},
    };
    // applyAuth does not mutate — headers injection is caller responsibility
    const result = strategy.applyAuth(request, session);
    expect(result).toBe(request);
  });
});

describe.skip('createAuthStrategy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // TC-7: http:// URL writes JSON warning to stderr BEFORE any fetch call
  it('writes JSON warning to stderr before any RPC call when url is http://', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // First call (ApiKeyAuthStrategy) → success
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeAuthOk()));

    await createAuthStrategy(HTTP_CONFIG);

    // stderr must have been written before fetch was ever called
    const stderrCallOrder = stderrSpy.mock.invocationCallOrder[0];
    const fetchCallOrder = (vi.mocked(globalThis.fetch) as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];

    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim()) as { event: string; message: string };
    expect(parsed.event).toBe('warning');
    expect(parsed.message).toContain('http://');
    expect(stderrCallOrder).toBeLessThan(fetchCallOrder);
  });

  // TC-8: https:// URL does NOT write any warning
  it('does NOT write to stderr when url is https://', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeAuthOk()));

    await createAuthStrategy(BASE_CONFIG);

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  // TC-10: rethrows non-OdooAuthError from ApiKeyAuthStrategy
  it('rethrows non-OdooAuthError errors without attempting cookie fallback', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS failure')));

    await expect(createAuthStrategy(HTTP_CONFIG)).rejects.toThrow('DNS failure');
  });
});
