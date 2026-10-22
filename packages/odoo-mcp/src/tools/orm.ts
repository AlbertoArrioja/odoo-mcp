import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';
import type { ZodError } from 'zod';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ClientResolver, RequestContext } from '../types.js';

/** Structural type for AsyncLocalStorage — avoids @types/node dependency. */
type AsyncLocalStorageLike<T> = { getStore(): T | undefined };
import { readSchema, searchCountSchema, searchReadSchema } from './schemas.js';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
};

/** Retrieve the user_id from AsyncLocalStorage context set by HTTP transport (T-11). */
export async function getUserId(): Promise<string | undefined> {
  try {
    // Lazy access — http-transport.ts exports requestContextStorage in T-11
    const httpTransport = (await import('../http-transport.js')) as unknown as {
      requestContextStorage?: AsyncLocalStorageLike<RequestContext>;
    };
    return httpTransport.requestContextStorage?.getStore()?.user_id;
  } catch {
    return undefined;
  }
}

/** Format a ZodError as an InputValidationError tool result. */
export function zodErrorResult(
  tool: string,
  err: ZodError,
  logger: Logger,
  t0: number,
  rawArgs: Record<string, unknown>,
  user_id: string | undefined,
): ToolResult {
  const message = err.issues.map((i) => i.message).join('; ');
  return inputErrorResult(tool, message, logger, t0, rawArgs, user_id);
}

/** Log and return an InputValidationError tool result with the given message. */
export function inputErrorResult(
  tool: string,
  message: string,
  logger: Logger,
  t0: number,
  rawArgs: Record<string, unknown>,
  user_id: string | undefined,
): ToolResult {
  logger.toolCall({
    tool,
    args_sanitized: sanitizeArgs(rawArgs),
    latency_ms: Date.now() - t0,
    status: 'error',
    error: 'InputValidationError',
    user_id,
  });
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error_type: 'InputValidationError', message }),
      },
    ],
    isError: true,
  };
}

/** Shape every tool handler funnels through after SDK-level Zod parsing. */
export async function callOrm<
  T extends { allowed_company_ids?: number[]; active_company_id?: number },
>(
  tool: string,
  args: T,
  exec: (parsed: T, context: Context) => Promise<unknown>,
  logger: Logger,
  client: OdooClient,
  session: OdooSession,
  user_id: string | undefined,
): Promise<ToolResult> {
  const t0 = Date.now();
  const rawArgs = args as unknown as Record<string, unknown>;
  try {
    if (args.allowed_company_ids) {
      validateCompanySubset(args.allowed_company_ids, session.allowedCompanyIds);
    }
    const context = buildContext(session, {
      allowed_company_ids: args.allowed_company_ids,
      active_company_id: args.active_company_id,
    });
    const result = await exec(args, context);
    logger.toolCall({
      tool,
      args_sanitized: sanitizeArgs(rawArgs),
      latency_ms: Date.now() - t0,
      status: 'ok',
      user_id,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  } catch (e) {
    const latency_ms = Date.now() - t0;
    if (e instanceof OdooError) {
      const formatted = formatMcpError(e);
      logger.toolCall({
        tool,
        args_sanitized: sanitizeArgs(rawArgs),
        latency_ms,
        status: 'error',
        error: formatted.error_type,
        user_id,
      });
      return { content: [{ type: 'text', text: JSON.stringify(formatted) }], isError: true };
    }
    // Non-OdooError — log raw message to stderr, return generic InternalError
    // shape to MCP client (no internal-path / stack leakage).
    const message = e instanceof Error ? e.message : String(e);
    logger.toolCall({
      tool,
      args_sanitized: sanitizeArgs(rawArgs),
      latency_ms,
      status: 'error',
      error: 'InternalError',
      error_message: message,
      user_id,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error_type: 'InternalError',
            message: 'An internal error occurred',
          }),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Register the 3 read-only ORM tools on the MCP server using the 3-arg registerTool
 * overload that advertises the Zod input schema as JSON Schema in tools/list.
 *
 * Without inputSchema in the registration, MCP clients (Claude Code,
 * Claude Desktop, etc.) see an empty properties bag and strip every arg
 * before calling — making tools effectively unusable.
 */
export function registerOrmTools(
  server: McpServer,
  clientResolver: ClientResolver,
  logger: Logger,
): void {
  server.registerTool(
    'odoo_search_read',
    {
      description:
        'Search and read records in one call. Returns matching rows up to `limit` (default 80).',
      inputSchema: searchReadSchema.shape,
    },
    async (args) => {
      const { client, session } = await clientResolver();
      const user_id = await getUserId();
      const t0 = Date.now();
      const rawArgs = args as unknown as Record<string, unknown>;
      const parseResult = searchReadSchema.safeParse(args);
      if (!parseResult.success)
        return zodErrorResult('odoo_search_read', parseResult.error, logger, t0, rawArgs, user_id);
      return callOrm(
        'odoo_search_read',
        parseResult.data,
        (parsed, context) =>
          client.searchRead(parsed.model, parsed.domain as never[], parsed.fields, {
            limit: parsed.limit,
            offset: parsed.offset,
            order: parsed.order,
            context,
          }),
        logger,
        client,
        session,
        user_id,
      );
    },
  );

  server.registerTool(
    'odoo_read',
    {
      description: 'Read specific record IDs from a model. Returns one row per ID.',
      inputSchema: readSchema.shape,
    },
    async (args) => {
      const { client, session } = await clientResolver();
      const user_id = await getUserId();
      const t0 = Date.now();
      const rawArgs = args as unknown as Record<string, unknown>;
      const parseResult = readSchema.safeParse(args);
      if (!parseResult.success)
        return zodErrorResult('odoo_read', parseResult.error, logger, t0, rawArgs, user_id);
      return callOrm(
        'odoo_read',
        parseResult.data,
        (parsed, context) => client.read(parsed.model, parsed.ids, parsed.fields, context),
        logger,
        client,
        session,
        user_id,
      );
    },
  );

  server.registerTool(
    'odoo_search_count',
    {
      description: 'Count records matching the domain. Returns an integer.',
      inputSchema: searchCountSchema.shape,
    },
    async (args) => {
      const { client, session } = await clientResolver();
      const user_id = await getUserId();
      const t0 = Date.now();
      const rawArgs = args as unknown as Record<string, unknown>;
      const parseResult = searchCountSchema.safeParse(args);
      if (!parseResult.success)
        return zodErrorResult('odoo_search_count', parseResult.error, logger, t0, rawArgs, user_id);
      return callOrm(
        'odoo_search_count',
        parseResult.data,
        (parsed, context) => client.searchCount(parsed.model, parsed.domain as never[], context),
        logger,
        client,
        session,
        user_id,
      );
    },
  );
}
