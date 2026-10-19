import { z } from 'zod';

// Threat-model US-5 AC-9 (extended to all tools as defense-in-depth):
// Reject model names with characters that could escape Odoo's expected dotted_snake_case.
const MODEL_NAME = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_.]*$/, 'model must match /^[a-z][a-z0-9_.]*$/');

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
