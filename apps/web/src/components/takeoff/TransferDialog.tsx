/**
 * گفت‌وگوی «انتقال به برآورد» (D-016 Phase 4 از طریق UI) — فقط برای سند نهایی‌شده.
 * مقصد باید یک نسخهٔ پیش‌نویس از برآوردی «همان پروژه» باشد؛ نتیجهٔ انتقال
 * (ردیف‌های منتقل‌شده، اقلام بدون کد، خطاهای اتصال به فهرست‌بها) دقیقاً از
 * پاسخ API نمایش داده می‌شود. رفتار backend دست نمی‌خورد.
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { Estimate, TakeoffTransferResult } from '../../api/types.js';
import { ApiError } from '../../api/client.js';
import { useApi } from '../../api/context.js';
import {
  Button,
  Field,
  FormError,
  FormValidationError,
  Ltr,
  LoadingView,
  Modal,
  Select,
} from '../ui/primitives.js';
import { formatDecimal } from '../../format.js';

export function TransferDialog({
  projectId,
  documentId,
  onClose,
}: {
  projectId: string;
  documentId: string;
  onClose: () => void;
}): ReactElement {
  const api = useApi();
  const [estimates, setEstimates] = useState<readonly Estimate[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<Error | undefined>(undefined);
  const [estimateId, setEstimateId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [result, setResult] = useState<TakeoffTransferResult | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .listEstimates(projectId)
      .then((list) => {
        if (!cancelled) setEstimates(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause : new Error(String(cause)));
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectId]);

  const selectedEstimate = estimates?.find((estimate) => estimate.estimateId === estimateId);
  const draftVersions =
    selectedEstimate?.versions.filter((version) => version.status === 'draft') ?? [];

  const transfer = (): void => {
    if (versionId === '') return;
    setBusy(true);
    setError(undefined);
    api
      .transferTakeoffToBoq(projectId, documentId, versionId)
      .then((value) => {
        setResult(value);
      })
      .catch((cause: unknown) => {
        // پیام قطعی «قبلاً منتقل شده» جای پیام عمومی را می‌گیرد (رفتار تکرار، Phase 4)
        const already = alreadyTransferredMessage(cause);
        setError(
          already !== undefined
            ? new FormValidationError(already)
            : cause instanceof Error
              ? cause
              : new Error(String(cause)),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal title="انتقال صورت‌برداشت به برآورد (BOQ)" onClose={onClose}>
      {loadError !== undefined && <FormError error={loadError} />}
      {estimates === undefined && loadError === undefined && (
        <LoadingView label="در حال دریافت برآوردها…" />
      )}
      {estimates !== undefined && result === undefined && (
        <div className="form">
          <p className="field-hint">
            برای هر کد آیتم، یک ردیف BOQ در نسخهٔ انتخابی ساخته می‌شود (جمع آیتم از محاسبهٔ
            نهایی‌شده). اقلام بدون کد منتقل نمی‌شوند و در نتیجه گزارش می‌شوند.
          </p>
          <Field label="برآورد مقصد *">
            <Select
              value={estimateId}
              aria-label="برآورد مقصد"
              onChange={(event) => {
                setEstimateId(event.target.value);
                setVersionId('');
              }}
            >
              <option value="">— انتخاب برآورد —</option>
              {estimates.map((estimate) => (
                <option key={estimate.estimateId} value={estimate.estimateId}>
                  {estimate.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="نسخهٔ مقصد (فقط پیش‌نویس) *">
            <Select
              value={versionId}
              aria-label="نسخهٔ مقصد"
              disabled={estimateId === ''}
              onChange={(event) => {
                setVersionId(event.target.value);
              }}
            >
              <option value="">— انتخاب نسخه —</option>
              {draftVersions.map((version) => (
                <option key={version.versionId} value={version.versionId}>
                  {`نسخهٔ ${String(version.versionNumber)} (پیش‌نویس)`}
                </option>
              ))}
            </Select>
          </Field>
          <FormError error={error} />
          <div className="form-actions">
            <Button onClick={onClose}>بستن</Button>
            <Button variant="primary" busy={busy} disabled={versionId === ''} onClick={transfer}>
              انتقال به برآورد
            </Button>
          </div>
        </div>
      )}
      {result !== undefined && (
        <div className="form">
          <h3 className="section-title">نتیجهٔ انتقال</h3>
          {result.transferred.length > 0 && (
            <div className="table-wrap">
              <table className="boq-table">
                <thead>
                  <tr>
                    <th>کد آیتم</th>
                    <th>واحد</th>
                    <th>مقدار</th>
                    <th>ردیف BOQ</th>
                    <th>ردیف‌های متره مشارکت‌کننده</th>
                  </tr>
                </thead>
                <tbody>
                  {result.transferred.map((item) => (
                    <tr key={item.lineId}>
                      <td className="cell-code">
                        <Ltr>{item.itemCode}</Ltr>
                      </td>
                      <td className="cell-code">
                        <Ltr>{item.unit}</Ltr>
                      </td>
                      <td className="cell-num">
                        <Ltr>{formatDecimal(item.quantity)}</Ltr>
                      </td>
                      <td className="cell-code">
                        <Ltr>{item.lineId}</Ltr>
                      </td>
                      <td className="cell-code">
                        <Ltr>{item.lineIds.join('، ')}</Ltr>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.skipped.length > 0 && (
            <>
              <h4 className="form-section-title">اقلام بدون کد (منتقل نشدند و در متره ماندند)</h4>
              <ul className="rule-list">
                {result.skipped.map((item, index) => (
                  <li key={`${item.unit}-${String(index)}`} className="rule-row">
                    <span>
                      بدون کد · واحد <Ltr>{item.unit}</Ltr> · مقدار{' '}
                      <Ltr>{formatDecimal(item.qty)}</Ltr> · ردیف‌ها{' '}
                      <Ltr>{item.lineIds.join('، ')}</Ltr>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="form-actions">
            <Button onClick={onClose}>بستن</Button>
          </div>
        </div>
      )}
      {error !== undefined && result === undefined && estimates === undefined && (
        <FormError error={error} />
      )}
    </Modal>
  );
}

/**
 * پیام فارسی قطعی برای «قبلاً منتقل شده» (رفتار تکرار، Phase 4). کد ALREADY_TRANSFERRED
 * در `details.failures[].errors[]` پاسخ ۴۲۲ می‌نشیند (شکل واقعی API).
 */
export function alreadyTransferredMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== 'TAKEOFF_TRANSFER_REJECTED') return undefined;
  const failures = (
    error.details as { failures?: { code?: string; errors?: { code?: string }[] }[] } | undefined
  )?.failures;
  const already = failures?.some(
    (failure) =>
      failure.code === 'ALREADY_TRANSFERRED' ||
      failure.errors?.some((entry) => entry.code === 'ALREADY_TRANSFERRED'),
  );
  return already === true ? 'این صورت‌برداشت قبلاً به این برآورد منتقل شده است.' : undefined;
}
