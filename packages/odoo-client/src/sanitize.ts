// Key-name pattern that marks a value as PII; matched case-insensitively against
// every object key in the args tree. Adjust here if Odoo introduces new
// credential-bearing field names.
const PII_KEY_PATTERN = /password|credit_card|token|secret|api_key/i;

function redactObject(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (PII_KEY_PATTERN.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      redactObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          redactObject(item as Record<string, unknown>);
        }
      }
    }
  }
}

/**
 * Returns a sanitised copy of `args` with any PII-shaped keys replaced by
 * `'[REDACTED]'`. The args are deep-cloned via structuredClone, then the clone
 * is traversed recursively and any key matching PII_KEY_PATTERN has its value
 * redacted.
 *
 * Read-only fork: upstream only redacted the write tools (odoo_create,
 * odoo_write, odoo_execute, odoo_call_action). Those tools no longer exist, so
 * redaction now applies to every tool — tool args are small, and logs must
 * never carry raw credentials regardless of which tool received them.
 *
 * Used to build the `args_sanitized` field passed to `logger.toolCall` so
 * that log lines never contain raw credentials (US-9 AC-3).
 *
 * @param _toolName The MCP tool name. Kept for call-site compatibility.
 * @param args The original tool args. NEVER mutated.
 * @returns A deep-cloned and sanitised copy.
 */
export function sanitizeArgs(
  _toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = structuredClone(args);
  redactObject(cloned);
  return cloned;
}
