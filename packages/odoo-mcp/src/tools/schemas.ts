import { z } from 'zod';

// Threat-model US-5 AC-9 (extended to all tools as defense-in-depth):
// Reject model names with characters that could escape Odoo's expected dotted_snake_case.
// Exported so config.ts validates ODOO_MCP_AGGREGATE_MODELS with the same pattern.
export const MODEL_NAME_PATTERN = /^[a-z][a-z0-9_.]*$/;

const MODEL_NAME = z
  .string()
  .min(1)
  .regex(MODEL_NAME_PATTERN, 'model must match /^[a-z][a-z0-9_.]*$/');

// Field names: the model pattern without dots (no related paths, no leading
// underscore, so `__count` and private columns can never be addressed).
const FIELD = '[a-z][a-z0-9_]*';

/** Date granularities accepted on date/datetime groupby fields. */
export const GROUPBY_GRANULARITIES = ['day', 'week', 'month', 'quarter', 'year'] as const;

/** Aggregate functions accepted by odoo_read_group. */
export const AGGREGATE_FUNCTIONS = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'] as const;

const GROUPBY_SPEC_PATTERN = new RegExp(`^${FIELD}(:(${GROUPBY_GRANULARITIES.join('|')}))?$`);
const AGGREGATE_SPEC_PATTERN = new RegExp(`^${FIELD}:(${AGGREGATE_FUNCTIONS.join('|')})$`);
const ORDERBY_TERM_PATTERN = /^(\S+)(?:\s+(asc|desc))?$/;

/** Hard cap on groups returned by odoo_read_group. */
export const READ_GROUP_MAX_LIMIT = 500;

const companyContext = {
  allowed_company_ids: z.array(z.number().int().positive()).optional(),
  active_company_id: z.number().int().positive().optional(),
};

export const searchReadSchema = z.object({
  model: MODEL_NAME,
  domain: z.array(z.unknown()).default([]),
  fields: z.array(z.string()).default([]),
  limit: z.number().int().positive().default(80),
  offset: z.number().int().nonnegative().default(0),
  order: z.string().optional(),
  ...companyContext,
});

export type SearchReadInput = z.infer<typeof searchReadSchema>;

export const readSchema = z.object({
  model: MODEL_NAME,
  ids: z.array(z.number().int().positive()).min(1),
  fields: z.array(z.string()).default([]),
  ...companyContext,
});

export type ReadInput = z.infer<typeof readSchema>;

export const searchCountSchema = z.object({
  model: MODEL_NAME,
  domain: z.array(z.unknown()).default([]),
  ...companyContext,
});

export type SearchCountInput = z.infer<typeof searchCountSchema>;

export const fieldsGetSchema = z.object({
  model: MODEL_NAME,
  attributes: z.array(z.string()).optional(),
  ...companyContext,
});

export type FieldsGetInput = z.infer<typeof fieldsGetSchema>;

/**
 * odoo_read_group input. `readGroupSchema` is a plain ZodObject so its
 * `.shape` can be advertised in tools/list; `readGroupRequestSchema` adds the
 * cross-field checks (duplicates, orderby keys) and is what handlers parse.
 */
export const readGroupSchema = z.object({
  model: MODEL_NAME,
  domain: z.array(z.unknown()).default([]),
  groupby: z
    .array(
      z
        .string()
        .regex(
          GROUPBY_SPEC_PATTERN,
          `groupby must be "field" or "field:<${GROUPBY_GRANULARITIES.join('|')}>"`,
        ),
    )
    .max(5),
  aggregates: z
    .array(
      z
        .string()
        .regex(
          AGGREGATE_SPEC_PATTERN,
          `aggregates must be "field:<${AGGREGATE_FUNCTIONS.join('|')}>"`,
        ),
    )
    .max(20)
    .default([]),
  orderby: z.string().min(1).max(500).optional(),
  limit: z.number().int().positive().max(READ_GROUP_MAX_LIMIT).default(80),
  ...companyContext,
});

export const readGroupRequestSchema = readGroupSchema.superRefine((input, ctx) => {
  const duplicates = (items: string[]) => items.filter((item, i) => items.indexOf(item) !== i);
  for (const [key, items] of [
    ['groupby', input.groupby],
    ['aggregates', input.aggregates],
  ] as const) {
    const dups = duplicates(items);
    if (dups.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} contains duplicates: ${[...new Set(dups)].join(', ')}`,
      });
    }
  }

  if (input.orderby !== undefined) {
    const allowedKeys = new Set([...input.groupby, ...input.aggregates, '__count']);
    for (const term of input.orderby.split(',')) {
      const match = term.trim().match(ORDERBY_TERM_PATTERN);
      if (!match || !allowedKeys.has(match[1])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['orderby'],
          message:
            'orderby terms must be a groupby spec, an aggregate spec or __count, optionally followed by asc|desc',
        });
        return;
      }
    }
  }
});

export type ReadGroupInput = z.infer<typeof readGroupSchema>;
