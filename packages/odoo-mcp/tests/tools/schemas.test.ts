import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  searchReadSchema,
  readSchema,
  searchCountSchema,
  fieldsGetSchema,
} from '../../src/tools/schemas.js';

describe('searchReadSchema', () => {
  it('AC-1: parses minimal input with correct defaults', () => {
    const result = searchReadSchema.parse({ model: 'res.partner' });
    expect(result.model).toBe('res.partner');
    expect(result.domain).toEqual([]);
    expect(result.fields).toEqual([]);
    expect(result.limit).toBe(80);
    expect(result.offset).toBe(0);
    expect(result.allowed_company_ids).toBeUndefined();
    expect(result.active_company_id).toBeUndefined();
  });

  it('AC-2: throws ZodError for empty model string', () => {
    expect(() => searchReadSchema.parse({ model: '' })).toThrow(ZodError);
  });

  it('passes all fields when provided', () => {
    const result = searchReadSchema.parse({
      model: 'sale.order',
      domain: [['state', '=', 'sale']],
      fields: ['name', 'partner_id'],
      limit: 10,
      offset: 5,
      order: 'name asc',
      allowed_company_ids: [1, 2],
      active_company_id: 1,
    });
    expect(result.model).toBe('sale.order');
    expect(result.domain).toEqual([['state', '=', 'sale']]);
    expect(result.fields).toEqual(['name', 'partner_id']);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(5);
    expect(result.order).toBe('name asc');
    expect(result.allowed_company_ids).toEqual([1, 2]);
    expect(result.active_company_id).toBe(1);
  });

  it('throws ZodError for negative limit', () => {
    expect(() => searchReadSchema.parse({ model: 'res.partner', limit: -1 })).toThrow(ZodError);
  });

  it('throws ZodError for negative offset', () => {
    expect(() => searchReadSchema.parse({ model: 'res.partner', offset: -1 })).toThrow(ZodError);
  });
});

describe('readSchema', () => {
  it('parses with defaults', () => {
    const result = readSchema.parse({ model: 'res.partner', ids: [1, 2] });
    expect(result.model).toBe('res.partner');
    expect(result.ids).toEqual([1, 2]);
    expect(result.fields).toEqual([]);
  });

  it('throws ZodError for empty ids array', () => {
    expect(() => readSchema.parse({ model: 'res.partner', ids: [] })).toThrow(ZodError);
  });

  it('throws ZodError for missing ids', () => {
    expect(() => readSchema.parse({ model: 'res.partner' })).toThrow(ZodError);
  });
});

describe('searchCountSchema', () => {
  it('parses with default domain', () => {
    const result = searchCountSchema.parse({ model: 'res.partner' });
    expect(result.domain).toEqual([]);
  });

  it('parses with custom domain', () => {
    const result = searchCountSchema.parse({ model: 'res.partner', domain: [['active', '=', true]] });
    expect(result.domain).toEqual([['active', '=', true]]);
  });
});

describe('fieldsGetSchema', () => {
  it('parses with no attributes', () => {
    const result = fieldsGetSchema.parse({ model: 'res.partner' });
    expect(result.model).toBe('res.partner');
    expect(result.attributes).toBeUndefined();
  });

  it('parses with attributes list', () => {
    const result = fieldsGetSchema.parse({ model: 'res.partner', attributes: ['string', 'type'] });
    expect(result.attributes).toEqual(['string', 'type']);
  });
});

describe('AC-4: read-only schemas exported', () => {
  it('all schema exports are defined', () => {
    expect(searchReadSchema).toBeDefined();
    expect(readSchema).toBeDefined();
    expect(searchCountSchema).toBeDefined();
    expect(fieldsGetSchema).toBeDefined();
  });

  it('write-path schemas are no longer exported', async () => {
    const schemas = await import('../../src/tools/schemas.js');
    for (const removed of [
      'createSchema',
      'writeSchema',
      'unlinkSchema',
      'executeSchema',
      'runReportSchema',
      'callActionSchema',
    ]) {
      expect(schemas).not.toHaveProperty(removed);
    }
  });
});

// ---------------------------------------------------------------------------
// F-002: MODEL_NAME regex enforcement at schema level
// ---------------------------------------------------------------------------

describe('F-002: model regex enforced at schema level', () => {
  it('searchReadSchema rejects uppercase model (Res.Partner)', () => {
    expect(() => searchReadSchema.parse({ model: 'Res.Partner' })).toThrow(ZodError);
  });

  it('searchReadSchema accepts valid dotted_snake_case model (res.partner)', () => {
    expect(() => searchReadSchema.parse({ model: 'res.partner' })).not.toThrow();
  });
});
