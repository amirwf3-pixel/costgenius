/**
 * نمایش نتیجهٔ محاسبهٔ صورت‌برداشت نهایی‌شده (D-016) — فقط از snapshot تغییرناپذیر.
 * مقدار دقیق همیشه نمایش داده می‌شود؛ گردشده فقط وقتی هست که قاعده‌ای MATCH شده
 * باشد (هرگز ساخته نمی‌شود). ارجاع‌ها و lineIds آیتم‌ها، رابطهٔ provenance را
 * نشان می‌دهند.
 */
import type { ReactElement } from 'react';
import type { FinalizedTakeoffBundle } from '../../api/types.js';
import { formatDecimal } from '../../format.js';
import { Ltr } from '../ui/primitives.js';
import { displayQuantity } from './model.js';

export function TakeoffResultView({
  bundle,
  preview = false,
}: {
  /** The finalized bundle — or, for the P7-S2 preview, the draft document + engine result. */
  bundle: Pick<FinalizedTakeoffBundle, 'document' | 'result'>;
  /** P7-S2: preview mode — the caption says so; rendering is identical. */
  preview?: boolean;
}): ReactElement {
  const result = bundle.result;
  const lineById = new Map(
    bundle.document.sheets.flatMap((sheet) => sheet.lines.map((line) => [line.lineId, line])),
  );
  return (
    <div className="takeoff-result">
      <p className="card-sub">
        {preview
          ? 'نتیجهٔ پیش‌نمایش محاسبه است؛ هیچ چیزی ذخیره یا نهایی نمی‌شود. مشخصات موتور:'
          : 'نتیجه از snapshot تغییرناپذیر خوانده می‌شود؛ مشخصات موتور:'}{' '}
        <Ltr>{`${result.specId}@${result.specVersion} · engine ${result.engineVersion}`}</Ltr>
      </p>

      <h3 className="section-title">جمع آیتم‌ها (بر پایهٔ کد)</h3>
      <div className="table-wrap">
        <table className="boq-table">
          <thead>
            <tr>
              <th>کد آیتم</th>
              <th>واحد</th>
              <th>مقدار دقیق</th>
              <th>مقدار گرد شده</th>
              <th>مقدار مؤثر (انتقال به برآورد)</th>
              <th>ردیف‌های مشارکت‌کننده</th>
            </tr>
          </thead>
          <tbody>
            {result.itemTotals.map((total) => (
              <tr key={total.itemCode ?? 'uncoded'}>
                <td className="cell-code">
                  {total.itemCode === null ? (
                    <span className="cell-null">بدون کد</span>
                  ) : (
                    <Ltr>{total.itemCode}</Ltr>
                  )}
                </td>
                <td className="cell-code">
                  <Ltr>{total.unit}</Ltr>
                </td>
                <td className="cell-num">
                  <Ltr>{formatDecimal(total.exactQty)}</Ltr>
                </td>
                <td className="cell-num">
                  {total.roundedQty === undefined ? (
                    <span className="cell-null">—</span>
                  ) : (
                    <Ltr>{formatDecimal(total.roundedQty)}</Ltr>
                  )}
                </td>
                <td className="cell-num">
                  <Ltr>{formatDecimal(total.qty)}</Ltr>
                </td>
                <td className="cell-code">
                  <Ltr>{total.lineIds.join('، ')}</Ltr>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">ردیف‌ها (دقیق و گردشده)</h3>
      <div className="table-wrap">
        <table className="boq-table">
          <thead>
            <tr>
              <th>برگه</th>
              <th>ردیف</th>
              <th>شناسه</th>
              <th>شرح</th>
              <th>فرمول</th>
              <th>نوع</th>
              <th>مقدار دقیق</th>
              <th>مقدار گرد شده</th>
              <th>مقدار با علامت</th>
            </tr>
          </thead>
          <tbody>
            {result.lines.map((line) => {
              const source = lineById.get(line.lineId);
              return (
                <tr key={`${line.sheetId}-${line.lineId}`}>
                  <td className="cell-code">
                    <Ltr>{line.sheetId}</Ltr>
                  </td>
                  <td className="cell-num">
                    <Ltr>{String(line.rowNo)}</Ltr>
                  </td>
                  <td className="cell-code">
                    <Ltr>{line.lineId}</Ltr>
                  </td>
                  <td className="cell-desc">
                    {source?.description ?? '—'}
                    {source !== undefined && source.itemCode != null && (
                      <span className="row-secondary">
                        {' '}
                        (کد <Ltr>{source.itemCode}</Ltr>)
                      </span>
                    )}
                  </td>
                  <td className="cell-code">
                    {source === undefined ? '—' : <Ltr>{displayQuantity(source.quantity)}</Ltr>}
                  </td>
                  <td>{line.kind === 'addition' ? 'افزایش' : 'کسر'}</td>
                  <td className="cell-num">
                    <Ltr>{formatDecimal(line.exactMagnitude)}</Ltr>
                  </td>
                  <td className="cell-num">
                    {line.roundedMagnitude === undefined ? (
                      <span className="cell-null">—</span>
                    ) : (
                      <Ltr>{formatDecimal(line.roundedMagnitude)}</Ltr>
                    )}
                  </td>
                  <td className="cell-num">
                    <Ltr>{formatDecimal(line.signedValue)}</Ltr>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="field-hint">
        «مقدار گرد شده» فقط وقتی پر است که قاعده‌ای برای همان هدف هم‌خوان شده باشد؛ در غیر این صورت
        مقدار دقیق مرجع است و هیچ گردشده‌ای ساخته نمی‌شود.
      </p>
    </div>
  );
}
