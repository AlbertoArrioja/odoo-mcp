import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OdooError } from '../src/errors.js';
import {
  ALLOWED_EXECUTE_KW_METHODS,
  OdooReadOnlyViolation,
  assertReadOnlyRpc,
} from '../src/read-only.js';
import { jsonRpc } from '../src/rpc.js';

const URL = 'https://odoo.example.test';

/** Build execute_kw params the way OdooClient does. */
function executeKw(model: string, method: string): Record<string, unknown> {
  return {
    service: 'object',
    method: 'execute_kw',
    args: ['db', 7, 'placeholder-key', model, method, [], {}],
  };
}

describe('assertReadOnlyRpc', () => {
  it('pins the exact allowlist (fails if a method is added without review)', () => {
    expect([...ALLOWED_EXECUTE_KW_METHODS].sort()).toEqual(
      [
        'context_get',
        'fields_get',
        'formatted_read_group',
        'read',
        'read_group',
        'search_count',
        'search_read',
      ].sort(),
    );
  });

  it.each([...ALLOWED_EXECUTE_KW_METHODS])('allows execute_kw %s', (method) => {
    expect(() => assertReadOnlyRpc('/jsonrpc', executeKw('sale.order', method))).not.toThrow();
  });

  it.each(['authenticate', 'version'])('allows common.%s', (method) => {
    expect(() =>
      assertReadOnlyRpc('/jsonrpc', { service: 'common', method, args: [] }),
    ).not.toThrow();
  });

  it.each([
    'create',
    'write',
    'unlink',
    'copy',
    'action_post',
    'action_confirm',
    'button_validate',
    'message_post',
    'toggle_active',
    'name_create',
    'web_save',
    '_render_qweb_pdf',
    'read_group_raw',
    'READ',
    ' read',
  ])('rejects execute_kw %j', (method) => {
    expect(() => assertReadOnlyRpc('/jsonrpc', executeKw('res.partner', method))).toThrow(
      OdooReadOnlyViolation,
    );
  });

  it('rejects a non-string or missing model method', () => {
    for (const args of [undefined, [], ['db', 7, 'k', 'res.partner'], ['db', 7, 'k', 'm', 42]]) {
      expect(() =>
        assertReadOnlyRpc('/jsonrpc', { service: 'object', method: 'execute_kw', args }),
      ).toThrow(OdooReadOnlyViolation);
    }
  });

  it('rejects legacy object.execute even with an allowed method', () => {
    expect(() =>
      assertReadOnlyRpc('/jsonrpc', {
        service: 'object',
        method: 'execute',
        args: ['db', 7, 'k', 'res.partner', 'read', [1]],
      }),
    ).toThrow(OdooReadOnlyViolation);
  });

  it.each(['db', 'report', 'web', undefined])('rejects service %j', (service) => {
    expect(() =>
      assertReadOnlyRpc('/jsonrpc', { service, method: 'list', args: [] }),
    ).toThrow(OdooReadOnlyViolation);
  });

  it('rejects common methods other than authenticate/version', () => {
    expect(() =>
      assertReadOnlyRpc('/jsonrpc', { service: 'common', method: 'login', args: [] }),
    ).toThrow(OdooReadOnlyViolation);
  });

  it.each(['/web/dataset/call_kw', '/web/session/authenticate', '/xmlrpc/2/object', ''])(
    'rejects endpoint %j',
    (endpoint) => {
      expect(() => assertReadOnlyRpc(endpoint, executeKw('res.partner', 'read'))).toThrow(
        OdooReadOnlyViolation,
      );
    },
  );

  it('violation is an OdooError with errorType ReadOnlyViolation and model/method context', () => {
    let caught: unknown;
    try {
      assertReadOnlyRpc('/jsonrpc', executeKw('account.move', 'action_post'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OdooError);
    const err = caught as OdooError;
    expect(err.errorType).toBe('ReadOnlyViolation');
    expect(err.model).toBe('account.move');
    expect(err.method).toBe('action_post');
  });
});

describe('jsonRpc — allowlist enforced before network I/O', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a write without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(jsonRpc(URL, '/jsonrpc', executeKw('res.partner', 'write'))).rejects.toThrow(
      OdooReadOnlyViolation,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects the db service (drop/duplicate database) without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      jsonRpc(URL, '/jsonrpc', { service: 'db', method: 'drop', args: ['master', 'db'] }),
    ).rejects.toThrow(OdooReadOnlyViolation);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets an allowlisted read through to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(jsonRpc(URL, '/jsonrpc', executeKw('res.partner', 'search_read'))).resolves.toEqual(
      [],
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
