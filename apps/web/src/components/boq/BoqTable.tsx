/**
 * جدول ردیف‌های فهرست‌بها (§21–§24): کد و اعداد فنی LTR، مبالغ فقط جداکننده هزارگان
 * (مقدار دقیق تغییر نمی‌کند)، قیمت منفی بدون پوشاندن، قیمت null هرگز صفر نمایش
 * داده نمی‌شود و یادداشت‌های مأخذ (کسر بها و…) به‌صورت ثانویه نمایش می‌یابند.
 */
import type { BoqLine } from '../../api/types.js';
import { calculationStatusLabel, formatAmount, formatDecimal } from '../../format.js';
import { Ltr } from '../ui/primitives.js';
import type { ReactElement } from 'react';

const HEADERS = ['ردیف', 'کد', 'شرح', 'واحد', 'مقدار', 'بهای واحد', 'مبلغ'] as const;

export function BoqTable({ lines }: { lines: readonly BoqLine[] }): ReactElement {
  if (lines.length === 0) {
    return (
      <p className="state-hint">
        هنوز ردیفی ثبت نشده است. با «افزودن ردیف» کدهای فهرست‌بها ۱۴۰۴ را جستجو و اضافه کنید.
      </p>
    );
  }
  return (
    <div className="table-wrap" role="region" aria-label="ردیف‌های فهرست‌بها" tabIndex={0}>
      <table className="boq-table">
        <thead>
          <tr>
            {HEADERS.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <BoqRow key={line.lineId} line={line} index={index + 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoqRow({ line, index }: { line: BoqLine; index: number }): ReactElement {
  const hasNotes = line.notes.length > 0;
  const hasDeps = line.externalDependencies.length > 0;
  return (
    <tr>
      <td className="cell-num">{index}</td>
      <td className="cell-code">
        <Ltr>{line.pricebookCode}</Ltr>
      </td>
      <td className="cell-desc">
        <span>{line.description}</span>
        {(hasNotes || hasDeps) && (
          <span className="row-secondary">
            {hasNotes && <span className="row-note">{line.notes.join(' · ')}</span>}
            {hasDeps && (
              <span className="row-note">
                وابستگی بیرونی: <Ltr>{line.externalDependencies.join(', ')}</Ltr>
              </span>
            )}
          </span>
        )}
        <span className="row-secondary row-provenance">
          مأخذ:{' '}
          <Ltr>
            {`${line.sourceRef.sourceDocument} — صفحه ${line.sourceRef.printedPage} (${line.sourceRef.section})`}
          </Ltr>
        </span>
      </td>
      <td>{line.unit.label}</td>
      <td className="cell-num">
        <Ltr>{formatDecimal(line.quantity)}</Ltr>
      </td>
      <td className={`cell-num ${line.basePrice === null ? 'cell-null' : ''}`}>
        <Ltr>{formatAmount(line.basePrice)}</Ltr>
        {line.basePrice === null && (
          <span className="row-secondary">({calculationStatusLabel(line.calculationStatus)})</span>
        )}
      </td>
      <td
        className={`cell-num cell-amount ${line.lineAmount === null ? 'cell-null' : ''} ${line.lineAmount !== null && line.lineAmount.startsWith('-') ? 'cell-negative' : ''}`}
      >
        <Ltr>{formatAmount(line.lineAmount)}</Ltr>
      </td>
    </tr>
  );
}
