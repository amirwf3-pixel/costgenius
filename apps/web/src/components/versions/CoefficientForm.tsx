/**
 * فرم ضرایب S4 (§32): دقیقاً همان ورودی‌های قرارداد محاسبه/نهایی‌سازی backend —
 * مساحت‌ها و ضرایب به‌صورت رشته دقیق. هیچ ضریبی در frontend محاسبه یا پیش‌فرض
 * نمی‌شود؛ مقادیر خالی به backend ارسال نمی‌شوند تا خطای دقیق دامنه نشان داده شود.
 */
import type { ReactElement } from 'react';
import type { CoefficientInputs } from '../../api/types.js';
import { Button, Field, Select, TextInput } from '../ui/primitives.js';

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export interface CoefficientDraft {
  groundFloorArea: string;
  firstBasementArea: string;
  aboveGroundFloors: string[];
  belowGroundFloors: string[];
  totalBuildingFloorArea: string;
  planKind: 'capital' | 'non-capital';
  tenderRoute: 'tender-or-monopoly' | 'waived-or-other';
  regionId: string;
  regionalCoefficient: string;
  executionCost: string;
  lumpSumAmount: string;
}

export function emptyDraft(): CoefficientDraft {
  return {
    groundFloorArea: '',
    firstBasementArea: '',
    aboveGroundFloors: [],
    belowGroundFloors: [],
    totalBuildingFloorArea: '',
    planKind: 'capital',
    tenderRoute: 'tender-or-monopoly',
    regionId: '',
    regionalCoefficient: '',
    executionCost: '',
    lumpSumAmount: '',
  };
}

/** Validates the draft locally (shape only) and builds the exact API payload. */
export function buildCoefficients(
  draft: CoefficientDraft,
  buildingId: string,
): { ok: true; value: CoefficientInputs } | { ok: false; error: string } {
  const required: Array<[string, string]> = [
    ['مساحت همکف', draft.groundFloorArea],
    ['مساحت زیرزمین اول', draft.firstBasementArea],
    ['مساحت کل طبقات', draft.totalBuildingFloorArea],
    ['هزینه اجرای منطقه', draft.executionCost],
  ];
  for (const [label, value] of required) {
    if (!DECIMAL_PATTERN.test(value)) {
      return { ok: false, error: `${label} باید یک عدد دقیق باشد.` };
    }
  }
  if (draft.regionalCoefficient.length > 0 && !DECIMAL_PATTERN.test(draft.regionalCoefficient)) {
    return { ok: false, error: 'ضریب منطقه باید یک عدد دقیق باشد.' };
  }
  for (const [label, floors] of [
    ['طبقات فوقانی', draft.aboveGroundFloors],
    ['طبقات زیرزمین', draft.belowGroundFloors],
  ] as const) {
    for (const area of floors) {
      if (!DECIMAL_PATTERN.test(area)) {
        return { ok: false, error: `مساحت ${label} باید عدد دقیق باشد.` };
      }
    }
  }
  const lumpSum = draft.lumpSumAmount.trim();
  return {
    ok: true,
    value: {
      floor: {
        buildingId,
        groundFloorArea: draft.groundFloorArea,
        firstBasementArea: draft.firstBasementArea,
        aboveGroundFloors: draft.aboveGroundFloors.map((area) => ({ area })),
        belowGroundFloors: draft.belowGroundFloors.map((area) => ({ area })),
        totalBuildingFloorArea: draft.totalBuildingFloorArea,
      },
      overhead: { planKind: draft.planKind, tenderRoute: draft.tenderRoute },
      regional: {
        parts: [
          {
            ...(draft.regionId.trim().length > 0 ? { regionId: draft.regionId.trim() } : {}),
            coefficient: draft.regionalCoefficient.length > 0 ? draft.regionalCoefficient : null,
            executionCost: draft.executionCost,
          },
        ],
      },
      // خالی = null: هزینه تأسیسات سایت اختیاری است و null نسخه را ناقص نگه می‌دارد
      siteSetup: {
        lumpSumAmount: lumpSum.length > 0 && DECIMAL_PATTERN.test(lumpSum) ? lumpSum : null,
      },
    },
  };
}

export function CoefficientForm({
  draft,
  setDraft,
}: {
  draft: CoefficientDraft;
  setDraft: (draft: CoefficientDraft) => void;
}): ReactElement {
  return (
    <div className="coefficient-form">
      <h3 className="form-section-title">مرحله ۲ — ضریب طبقات (فهرست ضریب F)</h3>
      <div className="form-row">
        <Field label="مساحت همکف *">
          <TextInput
            className="input ltr-input"
            value={draft.groundFloorArea}
            onChange={(event) => setDraft({ ...draft, groundFloorArea: event.target.value })}
            placeholder="600"
          />
        </Field>
        <Field label="مساحت زیرزمین اول *">
          <TextInput
            className="input ltr-input"
            value={draft.firstBasementArea}
            onChange={(event) => setDraft({ ...draft, firstBasementArea: event.target.value })}
            placeholder="400"
          />
        </Field>
        <Field label="مساحت کل طبقات *">
          <TextInput
            className="input ltr-input"
            value={draft.totalBuildingFloorArea}
            onChange={(event) => setDraft({ ...draft, totalBuildingFloorArea: event.target.value })}
            placeholder="7600"
          />
        </Field>
      </div>
      <FloorList
        title="طبقات فوق زمین"
        floors={draft.aboveGroundFloors}
        setFloors={(floors) => setDraft({ ...draft, aboveGroundFloors: floors })}
      />
      <FloorList
        title="طبقات زیر زمین"
        floors={draft.belowGroundFloors}
        setFloors={(floors) => setDraft({ ...draft, belowGroundFloors: floors })}
      />

      <h3 className="form-section-title">مرحله ۳ — سربار و مرحله ۴ — منطقه</h3>
      <div className="form-row">
        <Field label="نوع طرح">
          <Select
            value={draft.planKind}
            onChange={(event) =>
              setDraft({ ...draft, planKind: event.target.value as CoefficientDraft['planKind'] })
            }
          >
            <option value="capital">سرمایه‌ای</option>
            <option value="non-capital">غیرسرمایه‌ای</option>
          </Select>
        </Field>
        <Field label="شیوه تأمین">
          <Select
            value={draft.tenderRoute}
            onChange={(event) =>
              setDraft({
                ...draft,
                tenderRoute: event.target.value as CoefficientDraft['tenderRoute'],
              })
            }
          >
            <option value="tender-or-monopoly">مزایده/انحصار</option>
            <option value="waived-or-other">بخش‌شده/سایر</option>
          </Select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="شناسه منطقه (اختیاری)">
          <TextInput
            className="input ltr-input"
            value={draft.regionId}
            onChange={(event) => setDraft({ ...draft, regionId: event.target.value })}
            placeholder="r-tehran"
          />
        </Field>
        <Field label="ضریب منطقه" hint="اگر خالی بماند، نسخه ناقص می‌ماند (مقدار جعل نمی‌شود).">
          <TextInput
            className="input ltr-input"
            value={draft.regionalCoefficient}
            onChange={(event) => setDraft({ ...draft, regionalCoefficient: event.target.value })}
            placeholder="1.1"
          />
        </Field>
        <Field label="هزینه اجرای منطقه *">
          <TextInput
            className="input ltr-input"
            value={draft.executionCost}
            onChange={(event) => setDraft({ ...draft, executionCost: event.target.value })}
            placeholder="51828473.788"
          />
        </Field>
      </div>

      <h3 className="form-section-title">تأسیسات سایت (پیوست ۵)</h3>
      <Field label="مبلغ مقطوع" hint="خالی = بدون تأسیسات سایت (null؛ فهرست جعل نمی‌شود).">
        <TextInput
          className="input ltr-input"
          value={draft.lumpSumAmount}
          onChange={(event) => setDraft({ ...draft, lumpSumAmount: event.target.value })}
          placeholder="12000000"
        />
      </Field>
    </div>
  );
}

function FloorList({
  title,
  floors,
  setFloors,
}: {
  title: string;
  floors: string[];
  setFloors: (floors: string[]) => void;
}): ReactElement {
  return (
    <fieldset className="floor-list">
      <legend>{title}</legend>
      {floors.map((area, index) => (
        <div key={index} className="form-row">
          <Field label={`مساحت طبقه ${String(index + 1)}`}>
            <TextInput
              className="input ltr-input"
              value={area}
              onChange={(event) => {
                const next = [...floors];
                next[index] = event.target.value;
                setFloors(next);
              }}
              placeholder="500"
            />
          </Field>
          <Button
            variant="danger"
            onClick={() => setFloors(floors.filter((_, i) => i !== index))}
            aria-label={`حذف طبقه ${String(index + 1)}`}
          >
            حذف
          </Button>
        </div>
      ))}
      <Button onClick={() => setFloors([...floors, ''])}>+ افزودن طبقه</Button>
    </fieldset>
  );
}
