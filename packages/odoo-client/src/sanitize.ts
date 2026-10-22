// Key-name pattern that marks a value as PII; matched case-insensitively against
// every object key in the args tree, and against the field name of every
// domain-shaped triple. Adjust here if Odoo introduces new credential-bearing
// field names.
const PII_KEY_PATTERN = /password|credit_card|token|secret|api_key/i;

const REDACTED = '[REDACTED]';

/**
 * A domain leaf `[field, operator, value]`, e.g. `['password', '=', 'x']`.
 * The field may be a dotted path (`user_id.api_key`), which the pattern still
 * matches.
 */
function isPiiDomainLeaf(arr: unknown[]): boolean {
  return (
    arr.length === 3 &&
    typeof arr[0] === 'string' &&
    typeof arr[1] === 'string' &&
    PII_KEY_PATTERN.test(arr[0])
  );
}

function redact(value: unknown): void {
  if (Array.isArray(value)) {
    if (isPiiDomainLeaf(value)) value[2] = REDACTED;
    for (const item of value) redact(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (PII_KEY_PATTERN.test(key)) obj[key] = REDACTED;
    else redact(obj[key]);
  }
}

/**
 * Returns a sanitised copy of `args` for logging. The args are deep-cloned via
 * structuredClone, then the clone is traversed recursively and redacted:
 *   - any object key matching PII_KEY_PATTERN has its value replaced;
 *   - any domain leaf `[field, op, value]` whose field matches the pattern has
 *     its value replaced (domains are arrays, so key-based redaction alone
 *     would log `['password', '=', 'hunter2']` verbatim).
 *
 * Read-only fork: upstream only redacted the write tools (odoo_create,
 * odoo_write, odoo_execute, odoo_call_action). Those tools no longer exist, so
 * redaction now applies to every tool's args.
 *
 * Used to build the `args_sanitized` field passed to `logger.toolCall` so
 * that log lines never contain raw credentials (US-9 AC-3).
 *
 * @param args The original tool args. NEVER mutated.
 * @returns A deep-cloned and sanitised copy.
 */
export function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const cloned = structuredClone(args);
  redact(cloned);
  return cloned;
}
