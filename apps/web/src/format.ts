/**
 * PRESENTATION-ONLY formatting (§22/§23/§67). The exact backend decimal string is the
 * value; these helpers only insert thousands separators for readability and never
 * convert to Number, never round, never drop or add fraction digits:
 * '69011321.1668' → '69,011,321.1668' · '-1037000' → '-1,037,000' · null → 'ثبت نشده'.
 */

/** Groups the integer part of a decimal string with ',' — the fraction stays verbatim. */
export function formatDecimal(value: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value);
  if (match === null || match[2] === undefined) {
    return value; // not a plain decimal literal — show it untouched
  }
  const sign = match[1] ?? '';
  const fraction = match[3] ?? '';
  const grouped = match[2].replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fraction}`;
}

/** Null (unpriced/blocked) is NEVER shown as zero (§24). */
export function formatAmount(value: string | null): string {
  return value === null ? 'ثبت نشده' : formatDecimal(value);
}

/** ISO instant → Persian calendar date/time for display only. */
export function formatInstant(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** Persian status labels of the two real version states. */
export function statusLabel(status: string): string {
  return status === 'finalized' ? 'نهایی‌شده' : 'پیش‌نویس';
}

/** Persian labels of the known calculation statuses (from the engine's real values). */
export function calculationStatusLabel(status: string): string {
  switch (status) {
    case 'COMPLETE':
      return 'کامل';
    case 'INCOMPLETE':
      return 'ناقص (قیمت ثبت نشده)';
    case 'EXTERNAL_DEPENDENCY':
      return 'وابسته به اطلاعات بیرونی';
    case 'NOT_SPECIFIED':
      return 'تعیین‌نشده در مأخذ';
    default:
      return status;
  }
}
