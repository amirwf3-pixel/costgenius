import { describe, expect, it } from 'vitest';
import { DomainError, compareInstants, isUnitCode, parseId, parseInstant } from './index.js';

describe('identifiers', () => {
  it('accepts canonical UUIDv7 and rejects malformed ids', () => {
    const id = '01920000-0000-7000-8000-000000000000';
    expect(parseId(id, 'ProjectId')).toBe(id);
    expect(() => parseId('01920000-0000-7000-8000-00000000000Z', 'ProjectId')).toThrow(DomainError);
    expect(() => parseId('0192ABCD-0000-7000-8000-000000000000', 'ProjectId')).toThrow(DomainError);
    expect(() => parseId('', 'ProjectId')).toThrow(DomainError);
  });
});

describe('instants', () => {
  it('normalizes to millisecond UTC and orders correctly', () => {
    const a = parseInstant('2026-09-23T08:00:00Z');
    const b = parseInstant('2026-09-23T08:00:00.5Z');
    expect(a).toBe('2026-09-23T08:00:00.000Z');
    expect(b).toBe('2026-09-23T08:00:00.500Z');
    expect(compareInstants(a, b)).toBe(-1);
  });

  it('rejects non-UTC and invalid calendar dates', () => {
    expect(() => parseInstant('2026-09-23T08:00:00+03:30')).toThrow(DomainError);
    expect(() => parseInstant('2026-02-30T00:00:00Z')).toThrow(DomainError);
    expect(() => parseInstant('2026-09-23')).toThrow(DomainError);
  });
});

describe('units', () => {
  it('is a closed vocabulary', () => {
    expect(isUnitCode('m3')).toBe(true);
    expect(isUnitCode('M3')).toBe(false);
  });
});
