import { describe, it, expect } from 'vitest';
import { sanitizeArgs } from '../src/sanitize.js';

describe('sanitizeArgs', () => {
  it('redacts values under PII-shaped keys at any depth', () => {
    const args = { model: 'res.users', context: { api_key: 'k', nested: { Password: 'p' } } };
    expect(sanitizeArgs(args)).toEqual({
      model: 'res.users',
      context: { api_key: '[REDACTED]', nested: { Password: '[REDACTED]' } },
    });
  });

  it('redacts the value of domain leaves on PII-shaped fields', () => {
    const args = {
      domain: [
        '|',
        ['password', '=', 'hunter2'],
        ['user_id.api_key', 'ilike', 'abc'],
        ['name', '=', 'Acme'],
      ],
    };
    expect(sanitizeArgs(args)).toEqual({
      domain: [
        '|',
        ['password', '=', '[REDACTED]'],
        ['user_id.api_key', 'ilike', '[REDACTED]'],
        ['name', '=', 'Acme'],
      ],
    });
  });

  it('leaves field-name lists alone', () => {
    const args = { fields: ['login', 'password', 'api_key'] };
    expect(sanitizeArgs(args)).toEqual(args);
  });

  it('redacts objects nested inside arrays', () => {
    const args = { items: [[{ token: 't' }], { secret: 's' }] };
    expect(sanitizeArgs(args)).toEqual({
      items: [[{ token: '[REDACTED]' }], { secret: '[REDACTED]' }],
    });
  });

  it('never mutates the input', () => {
    const args = { domain: [['password', '=', 'hunter2']], api_key: 'k' };
    sanitizeArgs(args);
    expect(args).toEqual({ domain: [['password', '=', 'hunter2']], api_key: 'k' });
  });
});
