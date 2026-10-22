import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { OdooConfig } from '@netlinksinc/odoo-client';

// ---------------------------------------------------------------------------
// Guard rail for the read-only fork.
//
// Builds the server through the real production wiring
// (createOdooMcpServer → createServerInstance → registerAllTools +
// registerResources) and lists tools over a real MCP client. If anyone
// registers a new tool — in particular a write tool — this test fails until
// EXPECTED_TOOLS is updated in review.
// ---------------------------------------------------------------------------

const EXPECTED_TOOLS = [
  'odoo_fields_get',
  'odoo_read',
  'odoo_read_group',
  'odoo_search_count',
  'odoo_search_read',
];

const EXPECTED_RESOURCES = [
  'odoo://companies',
  'odoo://currencies',
  'odoo://fiscal-year',
  'odoo://modules',
  'odoo://reports',
  'odoo://server-actions',
  'odoo://user-context',
];

const REMOVED_TOOLS = [
  'odoo_create',
  'odoo_write',
  'odoo_unlink',
  'odoo_execute',
  'odoo_call_action',
  'odoo_run_report',
];

// Only the network-facing pieces are stubbed; tool/resource registration is real.
vi.mock('@netlinksinc/odoo-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@netlinksinc/odoo-client')>();
  const OdooClient = vi.fn().mockImplementation(() => ({
    authenticate: vi.fn().mockResolvedValue({
      uid: 1,
      companyId: 1,
      allowedCompanyIds: [1],
      userContext: {},
    }),
  }));
  return { ...actual, OdooClient };
});

vi.mock('../../src/probe.js', () => ({
  runProbe: vi.fn().mockResolvedValue({
    modules: [],
    reports: [],
    serverActions: [],
    companies: [],
    currencies: [],
    fiscalYear: { date_from: '2026-01-01', date_to: '2026-12-31' },
    language: 'en_US',
    locale: 'UTC',
  }),
}));

import { createOdooMcpServer } from '../../src/server.js';

const ODOO_CONFIG: OdooConfig = {
  url: 'https://odoo.example.test',
  db: 'testdb',
  username: 'user@example.test',
  apiKey: 'placeholder-key',
};

let client: Client;

beforeAll(async () => {
  const { createServerInstance } = await createOdooMcpServer({
    odooConfig: ODOO_CONFIG,
    clientResolver: async () => {
      throw new Error('tools must not be invoked by this test');
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServerInstance().connect(serverTransport);
  client = new Client({ name: 'registry-test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close();
});

describe('registered MCP surface (read-only fork)', () => {
  it('exposes exactly the expected read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('exposes none of the removed write/action/report tools', async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const removed of REMOVED_TOOLS) {
      expect(names.has(removed)).toBe(false);
    }
  });

  it('keeps the odoo:// resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([...EXPECTED_RESOURCES].sort());
  });
});
