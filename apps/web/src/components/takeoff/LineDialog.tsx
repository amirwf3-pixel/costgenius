/**
 * گفت‌وگوی افزودن/ویرایش ردیف صورت‌برداشت (D-016). حالت ویرایش داخل خود گفت‌وگو
 * نگه داشته می‌شود تا جابه‌جایی بین برگه‌ها یا تغییر حالت مقدار، مقادیر واردشده را
 * از بین نبرد؛ تا «ثبت» نشود، سند محلی تغییر نمی‌کند.
 */
import { useState, type ReactElement } from 'react';
import type { TakeoffLine, TakeoffQuantity } from '../../api/types.js';
import {
  Button,
  Field,
  FormError,
  FormValidationError,
  Modal,
  Select,
  TextInput,
} from '../ui/primitives.js';
import { QuantityEditor } from './QuantityEditor.js';
import {
  KIND_OPTIONS,
  UNIT_OPTIONS,
  allLines,
  displayQuantity,
  validateLineShape,
  type LineRef,
} from './model.js';

export function LineDialog({
  mode,
  sheetName,
  line,
  sheets,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  sheetName: string;
  /** در حالت ویرایش، ردیف موجود؛ در حالت ایجاد، ردیف خام با شناسهٔ تازه. */
  line: TakeoffLine;
  sheets: readonly {
    readonly sheetId: string;
    readonly name: string;
    readonly lines: readonly TakeoffLine[];
  }[];
  onClose: () => void;
  /** ردیف کامل‌شده را برمی‌گرداند؛ اعتبارسنجی شکل اینجا صریح است. */
  onSubmit: (line: TakeoffLine) => void;
}): ReactElement {
  const [draft, setDraft] = useState<TakeoffLine>(line);
  const [error, setError] = useState<Error | undefined>(undefined);
  // ردیف‌های دیگر سند برای انتخاب‌گر مرجع (ارجاع بین‌برگه‌ای مجاز است) — خودِ ردیف
  // فعلی در حالت ویرایش از فهرست خارج می‌شود تا ردیف به خودش ارجاع ندهد.
  const referenceLines: readonly LineRef[] = allLines(sheets).filter(
    (ref) => !(mode === 'edit' && ref.line.lineId === line.lineId),
  );

  const patch = (changes: Partial<TakeoffLine>): void => {
    setDraft((current) => ({ ...current, ...changes }));
  };

  const submit = (): void => {
    const shape = validateLineShape(draft);
    const duplicates = new Set(
      allLines(sheets)
        .filter((ref) => mode === 'create' || ref.line.lineId !== line.lineId)
        .map((ref) => ref.line.lineId),
    );
    const issues = [...shape.issues];
    if (draft.lineId.trim().length === 0) issues.push('شناسهٔ ردیف را وارد کنید.');
    if (duplicates.has(draft.lineId.trim())) issues.push('شناسهٔ ردیف در این سند تکراری است.');
    if (!Number.isInteger(draft.rowNo) || draft.rowNo < 1)
      issues.push('شمارهٔ ردیف باید عدد صحیح ≥ ۱ باشد.');
    if (issues.length > 0) {
      setError(new FormValidationError(issues.join(' ')));
      return;
    }
    onSubmit(draft);
  };

  return (
    <Modal
      title={mode === 'create' ? `افزودن ردیف به «${sheetName}»` : `ویرایش ردیف ${draft.lineId}`}
      onClose={onClose}
    >
      <div className="form">
        <div className="form-row">
          <Field label="شناسهٔ ردیف *" hint="پایدار در کل سند؛ ارجاع‌ها با همین شناسه کار می‌کنند.">
            <TextInput
              value={draft.lineId}
              dir="ltr"
              aria-label="شناسهٔ ردیف"
              onChange={(event) => {
                patch({ lineId: event.target.value });
              }}
            />
          </Field>
          <Field label="شمارهٔ ردیف *">
            <TextInput
              value={String(draft.rowNo)}
              inputMode="numeric"
              dir="ltr"
              aria-label="شمارهٔ ردیف"
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                patch({ rowNo: Number.isNaN(parsed) ? 0 : parsed });
              }}
            />
          </Field>
        </div>
        <Field label="شرح *">
          <TextInput
            value={draft.description}
            aria-label="شرح ردیف"
            onChange={(event) => {
              patch({ description: event.target.value });
            }}
          />
        </Field>
        <div className="form-row">
          <Field label="محل / مکان (اختیاری)">
            <TextInput
              value={draft.location ?? ''}
              aria-label="محل"
              onChange={(event) => {
                patch({ location: event.target.value });
              }}
            />
          </Field>
          <Field
            label="کد آیتم فهرست‌بها (اختیاری)"
            hint="کد دقیق چاپی؛ خالی یعنی بدون کد (به برآورد منتقل نمی‌شود)."
          >
            <TextInput
              value={draft.itemCode ?? ''}
              dir="ltr"
              aria-label="کد آیتم"
              onChange={(event) => {
                patch({ itemCode: event.target.value });
              }}
            />
          </Field>
        </div>
        <div className="form-row">
          <Field label="نوع ردیف *">
            <Select
              value={draft.kind}
              aria-label="نوع ردیف"
              onChange={(event) => {
                patch({ kind: event.target.value as TakeoffLine['kind'] });
              }}
            >
              {KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="واحد *" hint="بدون تبدیل — واحد باید با ردیف فهرست‌بها یکسان باشد.">
            <Select
              value={draft.unit}
              aria-label="واحد"
              onChange={(event) => {
                patch({ unit: event.target.value });
              }}
            >
              {UNIT_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="form-section-title">مقدار / فرمول</div>
        <QuantityEditor
          quantity={draft.quantity}
          lines={referenceLines}
          onChange={(quantity: TakeoffQuantity) => {
            patch({ quantity });
          }}
        />
        <Field label="یادداشت (اختیاری)">
          <TextInput
            value={draft.notes ?? ''}
            aria-label="یادداشت"
            onChange={(event) => {
              patch({ notes: event.target.value });
            }}
          />
        </Field>
        <p className="field-hint">
          نمایش قطعی فرمول: <span className="ltr">{displayQuantity(draft.quantity)}</span>
        </p>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>انصراف</Button>
          <Button variant="primary" onClick={submit}>
            {mode === 'create' ? 'افزودن ردیف' : 'ثبت ویرایش'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
