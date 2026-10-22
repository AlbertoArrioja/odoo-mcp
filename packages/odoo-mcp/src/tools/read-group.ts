import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Logger } from '../logger.js';
import type { ClientResolver } from '../types.js';
import { callOrm, getUserId, inputErrorResult, zodErrorResult } from './orm.js';
import {
  AGGREGATE_FUNCTIONS,
  GROUPBY_GRANULARITIES,
  READ_GROUP_MAX_LIMIT,
  readGroupRequestSchema,
  readGroupSchema,
} from './schemas.js';

const TOOL = 'odoo_read_group';

function describeTool(allowedModels: readonly string[]): string {
  const enabled =
    allowedModels.length > 0
      ? `Enabled models: ${allowedModels.join(', ')}.`
      : 'Currently DISABLED: ODOO_MCP_AGGREGATE_MODELS is not set, every call is rejected.';
  return [
    'Server-side aggregation (SQL GROUP BY in Odoo). PREFER THIS over odoo_search_read for any',
    'question about totals, sums, counts, averages, minimums/maximums or breakdowns "by" something',
    '(by customer, by month, by salesperson, by state…): it returns one row per group instead of',
    'every record, so results are exact and not truncated at the search_read row limit.',
    `groupby: fields to group by; date/datetime fields need a granularity "field:<${GROUPBY_GRANULARITIES.join('|')}>"`,
    '(e.g. "date_order:month") or the call is rejected; an empty array returns a single overall group.',
    `aggregates: "field:<${AGGREGATE_FUNCTIONS.join('|')}>" (e.g. "amount_total:sum"); omit to get only the`,
    'record count. Every group always includes "__count".',
    'orderby: comma-separated groupby/aggregate specs or "__count", each optionally followed by asc|desc',
    '(e.g. "amount_total:sum desc").',
    `limit: max groups (default 80, max ${READ_GROUP_MAX_LIMIT}); "has_more": true means more groups exist.`,
    'Result: { groups: [{ "<groupby>": value, "<aggregate>": number, "__count": n }], has_more }.',
    'Many2one values are [id, name]; date groups are { value: "<range start>", label }.',
    enabled,
  ].join(' ');
}

/**
 * Register odoo_read_group. Only models listed in `allowedModels`
 * (ODOO_MCP_AGGREGATE_MODELS) are accepted; with an empty list every call is
 * rejected before any Odoo request. Calls run through `clientResolver`, i.e.
 * with the OdooClient of the authenticated session user — never a shared one.
 */
export function registerReadGroupTool(
  server: McpServer,
  clientResolver: ClientResolver,
  logger: Logger,
  allowedModels: readonly string[],
): void {
  const allowed = new Set(allowedModels);

  server.registerTool(
    TOOL,
    {
      description: describeTool(allowedModels),
      inputSchema: readGroupSchema.shape,
    },
    async (args) => {
      const user_id = await getUserId();
      const t0 = Date.now();
      const rawArgs = args as unknown as Record<string, unknown>;

      const parseResult = readGroupRequestSchema.safeParse(args);
      if (!parseResult.success)
        return zodErrorResult(TOOL, parseResult.error, logger, t0, rawArgs, user_id);
      const parsed = parseResult.data;

      // Model allowlist is checked before resolving the user's client, so a
      // rejected call never reaches Odoo.
      if (allowed.size === 0) {
        return inputErrorResult(
          TOOL,
          'odoo_read_group is disabled: ODOO_MCP_AGGREGATE_MODELS is not configured',
          logger,
          t0,
          rawArgs,
          user_id,
        );
      }
      if (!allowed.has(parsed.model)) {
        return inputErrorResult(
          TOOL,
          `model ${parsed.model} is not enabled for aggregation (allowed: ${allowedModels.join(', ')})`,
          logger,
          t0,
          rawArgs,
          user_id,
        );
      }

      const { client, session } = await clientResolver();
      return callOrm(
        TOOL,
        parsed,
        async (p, context) => {
          // Ask for one extra group to report has_more without a second query.
          const rows = await client.readGroup(
            p.model,
            {
              domain: p.domain,
              groupby: p.groupby,
              aggregates: p.aggregates,
              orderby: p.orderby,
              limit: p.limit + 1,
            },
            context,
          );
          return { groups: rows.slice(0, p.limit), has_more: rows.length > p.limit };
        },
        logger,
        client,
        session,
        user_id,
      );
    },
  );
}
