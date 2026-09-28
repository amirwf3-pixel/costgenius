/**
 * Presentation formatting must never change a value (§22/§23/§33/§67):
 * grouping only; exact fraction preserved; null never zero; negatives visible.
 */
import { describe, expect, it } from 'vitest';
import {
  calculationStatusLabel,
  formatAmount,
  formatDecimal,
  formatInstant,
  statusLabel,
} from '../src/format.js';

describe('formatDecimal', () => {
  it('groups the integer part and keeps the fraction verbatim', () => {
    expect(formatDecimal('69011321.1668')).toBe('69,011,321.1668');
    expect(formatDecimal('38147600')).toBe('38,147,600');
    expect(formatDecimal('1.30')).toBe('1.30');
    expect(formatDecimal('123456789012345678000001')).toBe('123,456,789,012,345,678,000,001');
  });

  it('keeps negatives explicit (never hidden or absolutized)', () => {
    expect(formatDecimal('-1037000')).toBe('-1,037,000');
    expect(formatDecimal('-2131000')).toBe('-2,131,000');
    expect(formatDecimal('-14632000.5')).toBe('-14,632,000.5');
  });

  it('keeps leading-zero-free codes and small numbers untouched', () => {
    expect(formatDecimal('2890')).toBe('2,890');
    expect(formatDecimal('0')).toBe('0');
    expect(formatDecimal('12.5')).toBe('12.5');
  });

  it('passes non-decimal strings through unchanged', () => {
    expect(formatDecimal('abc')).toBe('abc');
    expect(formatDecimal('')).toBe('');
  });
});

describe('formatAmount', () => {
  it('null (unpriced) is never zero — ثبت نشده (§24)', () => {
    expect(formatAmount(null)).toBe('ثبت نشده');
  });

  it('amounts are grouped for readability only', () => {
    expect(formatAmount('356790120245679009420002890')).toBe('356,790,120,245,679,009,420,002,890');
  });
});

describe('labels', () => {
  it('maps the two real version states', () => {
    expect(statusLabel('draft')).toBe('پیش‌نویس');
    expect(statusLabel('finalized')).toBe('نهایی‌شده');
  });

  it('maps the four real calculation statuses', () => {
    expect(calculationStatusLabel('COMPLETE')).toBe('کامل');
    expect(calculationStatusLabel('INCOMPLETE')).toContain('ناقص');
    expect(calculationStatusLabel('EXTERNAL_DEPENDENCY')).toContain('بیرونی');
    expect(calculationStatusLabel('NOT_SPECIFIED')).toContain('مأخذ');
  });

  it('formats instants for display without touching the value', () => {
    expect(formatInstant('2026-01-01T00:00:00Z')).toMatch(/۱۴۰۴|2026/);
    expect(formatInstant('not-an-instant')).toBe('not-an-instant');
  });
});
