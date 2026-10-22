import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Logger } from '../logger.js';
import type { ClientResolver } from '../types.js';
import { registerIntrospectTool } from './introspect.js';
import { registerOrmTools } from './orm.js';
import { registerReadGroupTool } from './read-group.js';

/**
 * Read-only fork: only tools that read from Odoo are registered. The write
 * paths (odoo_create, odoo_write, odoo_unlink, odoo_execute, odoo_call_action)
 * and odoo_run_report (private `_render_qweb_pdf`, may persist ir.attachment)
 * were removed together with their code. tests/tools/registry.test.ts pins
 * the exact list so adding a tool fails CI until the list is reviewed.
 */
export function registerAllTools(
  server: McpServer,
  clientResolver: ClientResolver,
  logger: Logger,
  options: { aggregateModels: readonly string[] } = { aggregateModels: [] },
): void {
  registerOrmTools(server, clientResolver, logger);
  registerIntrospectTool(server, clientResolver, logger);
  registerReadGroupTool(server, clientResolver, logger, options.aggregateModels);
}
