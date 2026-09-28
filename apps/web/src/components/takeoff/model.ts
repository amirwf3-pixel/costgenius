/**
 * D-016: مدل سمت رابط کاربری صورت‌برداشت — کمکی‌های «فقط ارائه» و اعتبارسنجی
 * ساختاریِ صریح. هیچ محاسبه‌ای اینجا انجام نمی‌شود (موتور محاسبه مرجع است)، هیچ
 * گرد کردن و تبدیل واحدی وجود ندارد و اعشارها همیشه رشتهٔ دقیق می‌مانند.
 *
 * - `displayQuantity`/`displayNode`: نمایش متنی قطعیِ فرمول (CG-FT §6.3) — فقط
 *   خواندنی است، هرگز تجزیه نمی‌شود و «زبان اجرا» نیست؛ نمایش LTR داخل چیدمان RTL.
 * - اعتبارسنجی سمت کلاینت فقط «شکل» را چک می‌کند (الگوهای اعشار/صحیح، فیلدهای
 *   الزامی، شناسه‌های تکراری) تا خطا پیش از ارسال دیده شود؛ اعتبارسنجی معنایی
 *   (ارجاع‌ها، سازگاری واحد، پروفایل ابعاد) فقط سمت سرور/موتور است و پیام‌هایش
 *   از همان‌جا می‌آید.
 */
import type {
  TakeoffDimensionalQuantity,
  TakeoffExpressionNode,
  TakeoffLine,
  TakeoffLineKind,
  TakeoffManualQuantity,
  TakeoffQuantity,
  TakeoffReferenceQuantity,
  TakeoffRoundingMode,
  TakeoffRoundingRule,
  TakeoffRoundingTarget,
  TakeoffSheet,
} from '../../api/types.js';

/** الگوی اعشار دقیقِ نامنفی (همان قالبی که موتور می‌پذیرد؛ بدون NaN/exponent/علامت). */
export const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
/** عدد صحیح ≥ 1 برای تعداد طبقات/تعداد مشابه (CG-IR-MEAS §2.1/V2). */
export const COUNT_PATTERN = /^[1-9]\d*$/;

/** واژگان بستهٔ واحدها (UNIT_CODES دامنه) — بدون تبدیل، بدون واحد آزاد. */
export const UNIT_OPTIONS: readonly { code: string; label: string }[] = [
  { code: 'm', label: 'متر (m)' },
  { code: 'm2', label: 'مترمربع (m2)' },
  { code: 'm3', label: 'مترمکعب (m3)' },
  { code: 'each', label: 'عدد (each)' },
  { code: 'kg', label: 'کیلوگرم (kg)' },
  { code: 't', label: 'تن (t)' },
  { code: 'l', label: 'لیتر (l)' },
  { code: 'lump_sum', label: 'فقره (lump_sum)' },
  { code: 'ton_km', label: 'تن‌کیلومتر (ton_km)' },
  { code: 'ton_nautical_mile', label: 'تن‌مایل دریایی' },
  { code: 'm2_month', label: 'مترمربع-ماه' },
  { code: 'm3_km', label: 'مترمکعب-کیلومتر' },
  { code: 'dm3', label: 'دسی‌مترمکعب (dm3)' },
  { code: 'percent', label: 'درصد (percent)' },
];

export const KIND_OPTIONS: readonly { value: TakeoffLineKind; label: string }[] = [
  { value: 'addition', label: 'افزایش' },
  { value: 'deduction', label: 'کسر' },
];

export const QUANTITY_TYPE_OPTIONS: readonly { value: TakeoffQuantity['type']; label: string }[] = [
  { value: 'dimensional', label: 'ابعادی (تعداد × ابعاد)' },
  { value: 'reference', label: 'ارجاع به ردیف‌ها' },
  { value: 'expression', label: 'عبارت ساخت‌یافته' },
  { value: 'manual', label: 'دستی' },
];

export const PROFILE_OPTIONS: readonly {
  value: TakeoffDimensionalQuantity['profile'];
  label: string;
}[] = [
  { value: 'count', label: 'فقط تعداد (بدون بُعد)' },
  { value: 'L', label: 'طول' },
  { value: 'LW', label: 'طول × عرض' },
  { value: 'LWH', label: 'طول × عرض × ارتفاع' },
];

export const ROUNDING_TARGET_OPTIONS: readonly {
  value: TakeoffRoundingTarget;
  label: string;
}[] = [
  { value: 'line', label: 'مقدار ردیف' },
  { value: 'reference-term', label: 'جملهٔ ارجاع' },
  { value: 'item-total', label: 'جمع آیتم (itemCode)' },
  { value: 'sheet-total', label: 'جمع برگه' },
];

export const ROUNDING_MODE_OPTIONS: readonly { value: TakeoffRoundingMode; label: string }[] = [
  { value: 'HALF_UP', label: 'نصف به بالا (HALF_UP)' },
  { value: 'HALF_EVEN', label: 'نصف به زوج (HALF_EVEN)' },
  { value: 'DOWN', label: 'به سمت صفر (DOWN)' },
  { value: 'UP', label: 'دور از صفر (UP)' },
  { value: 'FLOOR', label: 'به سمت −∞ (FLOOR)' },
  { value: 'CEIL', label: 'به سمت +∞ (CEIL)' },
];

/** برچسب وضعیت سند (سه وضعیت واقعی چرخهٔ عمر). */
export function takeoffStatusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'پیش‌نویس';
    case 'archived':
      return 'بایگانی‌شده';
    case 'finalized':
      return 'نهایی‌شده';
    default:
      return status;
  }
}

// -------------------------------------------------------------------------------------------------
// نمایش متنی قطعی فرمول (CG-FT §6.3) — فقط خواندنی؛ هرگز تجزیه نمی‌شود.
// -------------------------------------------------------------------------------------------------

function displayDimensional(q: TakeoffDimensionalQuantity): string {
  const parts: string[] = [];
  if (q.floorCount !== undefined && q.floorCount !== '') parts.push(q.floorCount);
  if (q.similarCount !== undefined && q.similarCount !== '') parts.push(q.similarCount);
  for (const dim of ['length', 'width', 'height'] as const) {
    const value = q[dim];
    if (value !== undefined && value !== '') parts.push(value);
  }
  return `(${parts.join(' × ')})`;
}

function displayReference(q: TakeoffReferenceQuantity): string {
  const terms = q.terms.map(
    (term) =>
      `${term.factor === '' ? '?' : term.factor} × ${term.use === 'magnitude' ? `|#${term.lineId}|` : `#${term.lineId}`}`,
  );
  return `(${terms.join(' + ')})`;
}

export function displayNode(node: TakeoffExpressionNode): string {
  switch (node.op) {
    case 'const':
      return node.value === '' ? '?' : node.value;
    case 'ref':
      return node.use === 'magnitude' ? `|#${node.lineId}|` : `#${node.lineId}`;
    case 'add':
      return `(${node.args.map(displayNode).join(' + ')})`;
    case 'mul':
      return `(${node.args.map(displayNode).join(' × ')})`;
    case 'sub':
      return `(${displayNode(node.args[0])} - ${displayNode(node.args[1])})`;
    case 'round':
      return `round(${displayNode(node.arg)}, ${String(node.rule.scale)}, ${node.rule.mode})`;
  }
}

function displayManual(q: TakeoffManualQuantity): string {
  return q.value === '' ? '?' : q.value;
}

/** نمایش متنی قطعی مقدار یک ردیف (برچسب نوع + فرمول) — LTR رندر می‌شود. */
export function displayQuantity(quantity: TakeoffQuantity): string {
  switch (quantity.type) {
    case 'dimensional':
      return `ابعادی ${displayDimensional(quantity)}`;
    case 'reference':
      return `ارجاع ${displayReference(quantity)}`;
    case 'expression':
      return `عبارت ${displayNode(quantity.node)}`;
    case 'manual':
      return `دستی ${displayManual(quantity)}`;
  }
}

// -------------------------------------------------------------------------------------------------
// کارخانه‌های پیش‌فرض (بدون مقدار پنهانی — فیلد غایب یعنی غایب، هرگز «1» نوشته نمی‌شود)
// -------------------------------------------------------------------------------------------------

export function newLineId(existing: readonly string[]): string {
  const ids = new Set(existing);
  let n = ids.size + 1;
  while (ids.has(`L${String(n)}`)) n += 1;
  return `L${String(n)}`;
}

export function newSheetId(existing: readonly string[]): string {
  const ids = new Set(existing);
  let n = ids.size + 1;
  while (ids.has(`S${String(n)}`)) n += 1;
  return `S${String(n)}`;
}

export function emptyDimensional(): TakeoffDimensionalQuantity {
  return { type: 'dimensional', profile: 'LW' };
}

export function emptyQuantity(): TakeoffQuantity {
  return emptyDimensional();
}

export function newLine(lineId: string, rowNo: number): TakeoffLine {
  return {
    lineId,
    rowNo,
    description: '',
    kind: 'addition',
    unit: 'm2',
    quantity: emptyQuantity(),
  };
}

export function newSheet(sheetId: string, name: string): TakeoffSheet {
  return { sheetId, name, lines: [] };
}

export function newRoundingRule(): TakeoffRoundingRule {
  return { target: 'item-total', scale: 0, mode: 'HALF_UP', sourceStatus: 'design' };
}

// -------------------------------------------------------------------------------------------------
// اعتبارسنجی ساختاری صریح سمت کلاینت (فقط شکل؛ معنا سمت سرور است)
// -------------------------------------------------------------------------------------------------

export interface LineIssues {
  /** پیام‌های فارسی کوتاه؛ خالی یعنی «از نظر شکل کامل». */
  readonly issues: readonly string[];
}

/** بررسی شکل یک ردیف: فیلدهای الزامی، الگوهای عددی، سازگاری پروفایل/ابعاد. */
export function validateLineShape(line: TakeoffLine): LineIssues {
  const issues: string[] = [];
  if (line.description.trim().length === 0) issues.push('شرح ردیف را وارد کنید.');
  const q = line.quantity;
  switch (q.type) {
    case 'dimensional': {
      const dims = ['length', 'width', 'height'] as const;
      const required: readonly string[] =
        q.profile === 'L'
          ? ['length']
          : q.profile === 'LW'
            ? ['length', 'width']
            : q.profile === 'LWH'
              ? ['length', 'width', 'height']
              : [];
      for (const dim of dims) {
        const value = q[dim];
        const present = value !== undefined && value !== '';
        if (required.includes(dim) && !present) {
          issues.push(`بُعد «${dimLabel(dim)}» برای این الگو الزامی است.`);
        }
        if (present && !DECIMAL_PATTERN.test(value)) {
          issues.push(`بُعد «${dimLabel(dim)}» باید عدد اعشاری دقیق نامنفی باشد.`);
        }
      }
      for (const factor of ['floorCount', 'similarCount'] as const) {
        const value = q[factor];
        if (value !== undefined && value !== '' && !COUNT_PATTERN.test(value)) {
          issues.push(
            factor === 'floorCount'
              ? 'تعداد طبقات باید عدد صحیح ≥ ۱ باشد.'
              : 'تعداد مشابه باید عدد صحیح ≥ ۱ باشد.',
          );
        }
      }
      break;
    }
    case 'reference': {
      if (q.terms.length === 0) issues.push('دست‌کم یک جملهٔ ارجاع لازم است.');
      q.terms.forEach((term, index) => {
        if (term.lineId === '') issues.push(`ردیف مرجع جملهٔ ${String(index + 1)} را انتخاب کنید.`);
        if (term.factor === '' || !/^-?\d+(\.\d+)?$/.test(term.factor)) {
          issues.push(`ضریب جملهٔ ${String(index + 1)} باید عدد اعشاری باشد.`);
        }
      });
      break;
    }
    case 'expression': {
      issues.push(...validateNodeShape(q.node));
      break;
    }
    case 'manual': {
      if (q.value === '' || !DECIMAL_PATTERN.test(q.value)) {
        issues.push('مقدار دستی باید عدد اعشاری دقیق نامنفی باشد.');
      }
      if (q.justification.trim().length === 0) {
        issues.push('دلیل مقدار دستی الزامی است.');
      }
      break;
    }
  }
  return { issues };
}

function dimLabel(dim: string): string {
  return dim === 'length' ? 'طول' : dim === 'width' ? 'عرض' : 'ارتفاع';
}

function validateNodeShape(node: TakeoffExpressionNode): string[] {
  const issues: string[] = [];
  switch (node.op) {
    case 'const':
      if (node.value === '' || !DECIMAL_PATTERN.test(node.value)) {
        issues.push('مقدار ثابت باید عدد اعشاری دقیق نامنفی باشد.');
      }
      break;
    case 'ref':
      if (node.lineId === '') issues.push('ردیف مرجع گره ارجاع را انتخاب کنید.');
      break;
    case 'add':
    case 'mul':
      if (node.args.length < 2) issues.push('عملگر جمع/ضرب دست‌کم دو عملوند لازم دارد.');
      for (const arg of node.args) issues.push(...validateNodeShape(arg));
      break;
    case 'sub':
      for (const arg of node.args) issues.push(...validateNodeShape(arg));
      break;
    case 'round': {
      issues.push(...validateNodeShape(node.arg));
      const scale = node.rule.scale;
      if (!Number.isInteger(scale) || scale < 0 || scale > 20) {
        issues.push('دقت گرد کردن باید عدد صحیح بین ۰ تا ۲۰ باشد.');
      }
      break;
    }
  }
  return issues;
}

/** همهٔ ردیف‌های سند به‌همراه برگهٔشان (برای انتخاب‌گر مرجع؛ ارجاع بین‌برگه‌ای مجاز است). */
export interface LineRef {
  readonly sheetId: string;
  readonly sheetName: string;
  readonly line: TakeoffLine;
}

export function allLines(sheets: readonly TakeoffSheet[]): readonly LineRef[] {
  return sheets.flatMap((sheet) =>
    sheet.lines.map((line) => ({ sheetId: sheet.sheetId, sheetName: sheet.name, line })),
  );
}

/** شناسه‌های تکراری ردیف/برگه در کل سند (سرور هم ۴۰۹ می‌دهد؛ اینجا زودتر دیده شود). */
export function duplicateKeyIssues(sheets: readonly TakeoffSheet[]): readonly string[] {
  const issues: string[] = [];
  const sheetIds = new Set<string>();
  for (const sheet of sheets) {
    if (sheetIds.has(sheet.sheetId)) issues.push(`شناسهٔ برگهٔ تکراری: ${sheet.sheetId}`);
    sheetIds.add(sheet.sheetId);
  }
  const lineIds = new Set<string>();
  for (const ref of allLines(sheets)) {
    if (lineIds.has(ref.line.lineId)) issues.push(`شناسهٔ ردیف تکراری: ${ref.line.lineId}`);
    lineIds.add(ref.line.lineId);
  }
  return issues;
}
