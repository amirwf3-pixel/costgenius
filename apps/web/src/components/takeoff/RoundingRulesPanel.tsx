/**
 * پنل قواعد گرد کردن سند (D-016 R1=A/R3=A) — فقط قواعد صریح با منشأ «طراحی».
 * مقدار دقیق همیشه مرجع است؛ گرد شده مشتق است و تجمیع همیشه از مقادیر دقیق
 * انجام می‌شود (هیچ حالت «گرد کردن تجمیعی» وجود ندارد). گرد کردن مستقل سمت
 * کلاینت انجام نمی‌شود — فقط همین قواعد ذخیره و به موتور سپرده می‌شوند.
 */
import { useState, type ReactElement } from 'react';
import type { TakeoffRoundingRule } from '../../api/types.js';
import {
  Button,
  Field,
  FormError,
  FormValidationError,
  Ltr,
  Modal,
  Select,
  TextInput,
} from '../ui/primitives.js';
import {
  ROUNDING_MODE_OPTIONS,
  ROUNDING_TARGET_OPTIONS,
  allLines,
  newRoundingRule,
} from './model.js';

export function RoundingRulesPanel({
  rules,
  disabled,
  sheets,
  onChange,
}: {
  rules: readonly TakeoffRoundingRule[];
  disabled: boolean;
  sheets: readonly {
    readonly sheetId: string;
    readonly lines: readonly { readonly lineId: string; readonly description: string }[];
  }[];
  onChange: (next: readonly TakeoffRoundingRule[]) => void;
}): ReactElement {
  const [editing, setEditing] = useState<number | 'new' | undefined>(undefined);
  const [draft, setDraft] = useState<TakeoffRoundingRule | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);

  const lineIds = allLines(sheets as never).map((ref) => ref.line.lineId);

  const openNew = (): void => {
    setDraft(newRoundingRule());
    setEditing('new');
    setError(undefined);
  };
  const openEdit = (index: number): void => {
    const rule = rules[index];
    if (rule === undefined) return;
    setDraft(rule);
    setEditing(index);
    setError(undefined);
  };

  const commit = (): void => {
    if (draft === undefined) return;
    if (!Number.isInteger(draft.scale) || draft.scale < 0 || draft.scale > 20) {
      setError(new FormValidationError('دقت گرد کردن باید عدد صحیح بین ۰ تا ۲۰ باشد.'));
      return;
    }
    const cleaned: TakeoffRoundingRule = {
      target: draft.target,
      ...(draft.selector !== undefined
        ? {
            selector: {
              ...(draft.selector.itemCode !== '' ? { itemCode: draft.selector.itemCode } : {}),
              ...(draft.selector.unit !== '' ? { unit: draft.selector.unit } : {}),
              ...(draft.selector.lineIds !== undefined && draft.selector.lineIds.length > 0
                ? { lineIds: draft.selector.lineIds }
                : {}),
            },
          }
        : {}),
      scale: draft.scale,
      mode: draft.mode,
      sourceStatus: 'design', // V1: فقط طراحی (R3=A)
      ...(draft.source !== undefined ? { source: draft.source } : {}),
    };
    onChange(
      editing === 'new'
        ? [...rules, cleaned]
        : rules.map((rule, i) => (i === editing ? cleaned : rule)),
    );
    setEditing(undefined);
    setDraft(undefined);
  };

  return (
    <section className="card" aria-labelledby="rounding-rules-title">
      <div className="card-main">
        <h3 id="rounding-rules-title" className="card-title">
          قواعد گرد کردن سند ({String(rules.length)})
        </h3>
        <p className="card-sub">
          مقدار دقیق همیشه مرجع است؛ گردشده مشتق است و فقط یک‌بار در هدفِ قاعده اعمال می‌شود. تجمیع
          از مقادیر دقیق انجام می‌شود و اگر قاعده‌ای هم‌خوان نشود، هیچ گرد کردنی رخ نمی‌دهد. منشأ
          قواعد در این نسخه فقط «طراحی» است.
        </p>
        {rules.length === 0 && (
          <p className="state-hint">قاعده‌ای تعریف نشده — همهٔ مقادیر دقیق می‌مانند.</p>
        )}
        {rules.length > 0 && (
          <ul className="rule-list">
            {rules.map((rule, index) => (
              <li key={`${rule.target}-${String(index)}`} className="rule-row">
                <span>
                  {targetLabel(rule.target)}
                  {rule.selector !== undefined && selectorLabel(rule.selector)}
                  {' — '}دقت <Ltr>{String(rule.scale)}</Ltr>، {rule.mode}، منشأ: طراحی
                </span>
                <span className="rule-actions">
                  <Button
                    disabled={disabled}
                    onClick={() => {
                      openEdit(index);
                    }}
                  >
                    ویرایش
                  </Button>
                  <Button
                    disabled={disabled}
                    onClick={() => {
                      onChange(rules.filter((_, i) => i !== index));
                    }}
                  >
                    حذف
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="form-actions">
          <Button disabled={disabled} onClick={openNew}>
            + قاعدهٔ گرد کردن
          </Button>
        </div>
      </div>

      {editing !== undefined && draft !== undefined && (
        <Modal
          title={editing === 'new' ? 'قاعدهٔ گرد کردن جدید' : 'ویرایش قاعدهٔ گرد کردن'}
          onClose={() => {
            setEditing(undefined);
            setDraft(undefined);
          }}
        >
          <div className="form">
            <Field label="هدف قاعده *">
              <Select
                value={draft.target}
                aria-label="هدف قاعده گرد کردن"
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    target: event.target.value as TakeoffRoundingRule['target'],
                  });
                }}
              >
                {ROUNDING_TARGET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="form-row">
              <Field label="کد آیتم انتخاب‌گر (اختیاری)">
                <TextInput
                  value={draft.selector?.itemCode ?? ''}
                  dir="ltr"
                  aria-label="کد آیتم انتخابگر"
                  onChange={(event) => {
                    const selector = draft.selector ?? {};
                    setDraft({ ...draft, selector: { ...selector, itemCode: event.target.value } });
                  }}
                />
              </Field>
              <Field label="واحد انتخاب‌گر (اختیاری)">
                <TextInput
                  value={draft.selector?.unit ?? ''}
                  dir="ltr"
                  aria-label="واحد انتخابگر"
                  onChange={(event) => {
                    const selector = draft.selector ?? {};
                    setDraft({ ...draft, selector: { ...selector, unit: event.target.value } });
                  }}
                />
              </Field>
            </div>
            {(draft.target === 'line' || draft.target === 'reference-term') && (
              <Field label="شناسهٔ ردیف‌های انتخاب‌گر (اختیاری، با کاما جدا کنید)">
                <TextInput
                  value={(draft.selector?.lineIds ?? []).join(',')}
                  dir="ltr"
                  aria-label="شناسه ردیف‌های انتخابگر"
                  onChange={(event) => {
                    const raw = event.target.value
                      .split(',')
                      .map((value) => value.trim())
                      .filter((value) => value.length > 0);
                    const selector = draft.selector ?? {};
                    setDraft({ ...draft, selector: { ...selector, lineIds: raw } });
                  }}
                />
              </Field>
            )}
            <p className="field-hint">
              ردیف‌های موجود: <Ltr>{lineIds.join('، ')}</Ltr>
            </p>
            <div className="form-row">
              <Field label="دقت (ارقام اعشار ۰ تا ۲۰) *">
                <TextInput
                  value={String(draft.scale)}
                  inputMode="numeric"
                  dir="ltr"
                  aria-label="دقت گرد کردن"
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.target.value, 10);
                    setDraft({ ...draft, scale: Number.isNaN(parsed) ? 0 : parsed });
                  }}
                />
              </Field>
              <Field label="روش گرد کردن *">
                <Select
                  value={draft.mode}
                  aria-label="روش گرد کردن"
                  onChange={(event) => {
                    setDraft({ ...draft, mode: event.target.value as TakeoffRoundingRule['mode'] });
                  }}
                >
                  {ROUNDING_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="field-hint">
              منشأ قاعدهٔ جدید در این نسخه فقط «طراحی» است (سیاست سازمان مجاز نیست)؛ منشأ قاعدهٔ
              موجود در ویرایش حفظ می‌شود.
            </p>
            <FormError error={error} />
            <div className="form-actions">
              <Button
                onClick={() => {
                  setEditing(undefined);
                  setDraft(undefined);
                }}
              >
                انصراف
              </Button>
              <Button variant="primary" onClick={commit}>
                ثبت قاعده
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function targetLabel(target: string): string {
  return ROUNDING_TARGET_OPTIONS.find((option) => option.value === target)?.label ?? target;
}

function selectorLabel(selector: NonNullable<TakeoffRoundingRule['selector']>): string {
  const parts: string[] = [];
  if (selector.itemCode !== undefined && selector.itemCode !== '')
    parts.push(`کد ${selector.itemCode}`);
  if (selector.unit !== undefined && selector.unit !== '') parts.push(`واحد ${selector.unit}`);
  if (selector.lineIds !== undefined && selector.lineIds.length > 0) {
    parts.push(`ردیف‌های ${selector.lineIds.join('+')}`);
  }
  return parts.length > 0 ? ` (${parts.join(' و ')})` : ' (همه)';
}
