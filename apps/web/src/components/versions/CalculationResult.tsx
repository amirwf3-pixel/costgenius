/**
 * نمایش نتیجه محاسبه (§31/§32): زنجیره مراحل S4 دقیقاً از پاسخ واقعی —
 * هیچ مقداری بازمحاسبه نمی‌شود؛ نمایش مبالغ فقط جداکننده هزارگان است (§33).
 */
import type { CalculationResult as CalculationResultData } from '../../api/types.js';
import { calculationStatusLabel, formatAmount, formatInstant } from '../../format.js';
import { Ltr } from '../ui/primitives.js';
import type { ReactElement } from 'react';

const STAGE_LABELS: Readonly<Record<string, string>> = {
  'base-subtotal': 'جمع ردیف‌های قیمت‌خورده',
  floor: 'ضریب طبقات (F)',
  overhead: 'سربار',
  regional: 'ضریب منطقه (R)',
  'site-setup': 'تأسیسات سایت',
};

export function CalculationResultView({
  calculation,
  finalizedAt,
}: {
  calculation: CalculationResultData;
  finalizedAt?: string;
}): ReactElement {
  const pending = [
    ...calculation.s4Result.pending.incomplete,
    ...calculation.s4Result.pending.externalDependencies,
    ...calculation.s4Result.pending.notSpecified,
  ];
  return (
    <div className="calc-result">
      <div className="calc-summary">
        <div className="calc-total">
          <span className="calc-total-label">جمع کل برآورد</span>
          <span
            className={`calc-total-value ${calculation.s4Result.finalEstimate === null ? 'cell-null' : ''}`}
          >
            <Ltr>{formatAmount(calculation.s4Result.finalEstimate)}</Ltr>
            <span className="calc-total-unit">ریال</span>
          </span>
        </div>
        <dl className="calc-meta">
          <div className="info-row">
            <dt>وضعیت محاسبه</dt>
            <dd>{calculationStatusLabel(calculation.s4Result.calculationStatus)}</dd>
          </div>
          <div className="info-row">
            <dt>جمع ردیف‌ها</dt>
            <dd>
              <Ltr>{formatAmount(calculation.rollup.amount)}</Ltr> ریال
            </dd>
          </div>
          <div className="info-row">
            <dt>ردیف‌ها</dt>
            <dd>
              {calculation.rollup.lineCount} (قیمت‌خورده {calculation.rollup.pricedLineCount} ·
              بازمانده {calculation.rollup.pendingLineCount})
            </dd>
          </div>
          {finalizedAt !== undefined && (
            <div className="info-row">
              <dt>تاریخ نهایی‌سازی</dt>
              <dd>{formatInstant(finalizedAt)}</dd>
            </div>
          )}
        </dl>
      </div>

      <table className="calc-stages">
        <thead>
          <tr>
            <th scope="col">مرحله</th>
            <th scope="col">ضریب</th>
            <th scope="col">نتیجه</th>
            <th scope="col">وضعیت</th>
          </tr>
        </thead>
        <tbody>
          {calculation.s4Result.stages.map((stage) => (
            <tr key={stage.stage}>
              <td>{STAGE_LABELS[stage.stage] ?? stage.stage}</td>
              <td className="cell-num">
                {stage.coefficient === null ? (
                  <span className="cell-null">—</span>
                ) : (
                  <Ltr>{stage.coefficient}</Ltr>
                )}
              </td>
              <td className={`cell-num ${stage.output === null ? 'cell-null' : ''}`}>
                <Ltr>{stage.output === null ? '—' : formatAmount(stage.output)}</Ltr>
              </td>
              <td>{calculationStatusLabel(stage.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {pending.length > 0 && (
        <div className="calc-pending" role="note">
          <p className="state-title">این نسخه جمع کامل ندارد؛ موارد باز:</p>
          <ul>
            {pending.map((reason) => (
              <li key={reason}>
                <Ltr>{reason}</Ltr>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
