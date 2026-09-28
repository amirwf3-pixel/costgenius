/**
 * میزکار نسخه (§19) — مهم‌ترین صفحه فاز ۱۸: سرنخ نسخه + وضعیت + خلاصه، جدول BOQ،
 * فرم ضرایب، محاسبه/بازبینی، نهایی‌سازی با تأیید، دانلود گزارش‌ها و ایجاد نسخه جدید.
 * در نسخه نهایی‌شده همه کنترل‌های تغییر حذف می‌شوند (§29) و فقط مشاهده/گزارش می‌ماند.
 */
import { useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../../api/context.js';
import { formatInstant, statusLabel } from '../../format.js';
import { useResource } from '../../hooks.js';
import {
  Badge,
  Button,
  ErrorView,
  FormError,
  FormValidationError,
  LoadingView,
  Ltr,
} from '../ui/primitives.js';
import { BoqTable } from '../boq/BoqTable.js';
import { AddLineDialog } from '../boq/AddLineDialog.js';
import {
  CoefficientForm,
  buildCoefficients,
  emptyDraft,
  type CoefficientDraft,
} from './CoefficientForm.js';
import { CalculationResultView } from './CalculationResult.js';
import { FinalizeDialog } from './FinalizeDialog.js';
import type { CalculationResult } from '../../api/types.js';

export function VersionWorkspacePage(): ReactElement {
  const { versionId } = useParams<{ versionId: string }>();
  const api = useApi();
  const navigate = useNavigate();
  const version = useResource(() => {
    if (versionId === undefined) return Promise.reject(new Error('نشانی نسخه نامعتبر است'));
    return api.getVersion(versionId);
  });

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<CoefficientDraft | undefined>(undefined);
  const [calculation, setCalculation] = useState<CalculationResult | undefined>(undefined);
  const [calculating, setCalculating] = useState(false);
  const [calcError, setCalcError] = useState<Error | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [downloading, setDownloading] = useState<'excel' | 'pdf' | undefined>(undefined);
  const [downloadError, setDownloadError] = useState<Error | undefined>(undefined);

  if (version.loading) return <LoadingView />;
  if (version.error !== undefined)
    return <ErrorView error={version.error} onRetry={version.reload} />;
  if (version.data === undefined) return <ErrorView error={new Error('نسخه پیدا نشد.')} />;

  const isFinalized = version.data.kind === 'finalized';
  const activeVersion = isFinalized
    ? version.data.bundle.estimate.versions.find((v) => v.versionId === versionId)
    : version.data.version;
  if (activeVersion === undefined) return <ErrorView error={new Error('نسخه پیدا نشد.')} />;

  const estimate = isFinalized ? version.data.bundle.estimate : undefined;
  const shownCalculation = isFinalized ? version.data.bundle.calculation : calculation;
  const buildingId = activeVersion.buildingId ?? '';

  const currentDraft = draft ?? emptyDraft();

  const runCalculate = async (): Promise<void> => {
    const built = buildCoefficients(currentDraft, buildingId);
    if (!built.ok) {
      setCalcError(new FormValidationError(built.error));
      return;
    }
    setCalculating(true);
    setCalcError(undefined);
    try {
      const result = await api.calculate(activeVersion.versionId, built.value);
      setCalculation(result);
    } catch (cause) {
      setCalcError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setCalculating(false);
    }
  };

  const download = async (kind: 'excel' | 'pdf'): Promise<void> => {
    if (versionId === undefined) return;
    setDownloading(kind);
    setDownloadError(undefined);
    try {
      const { blob, filename } = await api.downloadReport(versionId, kind);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setDownloading(undefined);
    }
  };

  const builtForFinalize = buildCoefficients(currentDraft, buildingId);

  return (
    <section aria-labelledby="version-title">
      <nav className="breadcrumb">
        <Link to="/projects" className="link">
          پروژه‌ها
        </Link>
        <span aria-hidden="true">›</span>
        <Link
          to={estimate !== undefined ? `/projects/${estimate.projectId}` : '/projects'}
          className="link"
        >
          پروژه
        </Link>
        <span aria-hidden="true">›</span>
        <Link to={`/estimates/${activeVersion.estimateId}`} className="link">
          برآورد
        </Link>
        <span aria-hidden="true">›</span>
        <span>نسخه {activeVersion.versionNumber}</span>
      </nav>

      <div className="page-head">
        <h1 id="version-title">
          نسخه {activeVersion.versionNumber}
          <Badge tone={isFinalized ? 'finalized' : 'draft'}>
            {statusLabel(activeVersion.status)}
          </Badge>
        </h1>
        <div className="page-actions">
          {isFinalized && estimate !== undefined && (
            <Button variant="primary" onClick={() => navigate(`/estimates/${estimate.estimateId}`)}>
              ایجاد نسخه جدید
            </Button>
          )}
        </div>
      </div>

      <dl className="info-grid">
        <div className="info-row">
          <dt>فهرست‌بها</dt>
          <dd>
            فهرست‌بها ۱۴۰۴ (<Ltr>{activeVersion.edition}</Ltr>)
          </dd>
        </div>
        <div className="info-row">
          <dt>ساختمان</dt>
          <dd>{activeVersion.buildingId ?? '—'}</dd>
        </div>
        <div className="info-row">
          <dt>تاریخ ایجاد</dt>
          <dd>{formatInstant(activeVersion.createdAt)}</dd>
        </div>
        <div className="info-row">
          <dt>تعداد ردیف‌ها</dt>
          <dd>{activeVersion.lines.length}</dd>
        </div>
      </dl>

      <h2 className="section-title">ردیف‌های فهرست‌بها</h2>
      <div className="section-actions">
        {!isFinalized && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            + افزودن ردیف
          </Button>
        )}
        {isFinalized && (
          <p className="state-hint">این نسخه نهایی شده است؛ ردیف‌ها تغییر نمی‌کنند.</p>
        )}
      </div>
      <BoqTable lines={activeVersion.lines} />

      <h2 className="section-title">محاسبه و بازبینی</h2>
      {!isFinalized && (
        <>
          <CoefficientForm draft={currentDraft} setDraft={setDraft} />
          <div className="section-actions">
            <Button
              variant="primary"
              busy={calculating}
              onClick={() => {
                void runCalculate();
              }}
            >
              محاسبه
            </Button>
            <Button
              variant="secondary"
              busy={confirming}
              disabled={!builtForFinalize.ok || calculation === undefined}
              onClick={() => setConfirming(true)}
            >
              نهایی‌سازی
            </Button>
            {calculation === undefined && (
              <span className="state-hint">
                پیش از نهایی‌سازی، ابتدا محاسبه را اجرا و نتیجه را بازبینی کنید.
              </span>
            )}
          </div>
          <FormError error={calcError} />
        </>
      )}

      {shownCalculation !== undefined && (
        <CalculationResultView
          calculation={shownCalculation}
          {...(isFinalized ? { finalizedAt: version.data.bundle.finalizedAt } : {})}
        />
      )}
      {!isFinalized && calculation === undefined && calcError === undefined && (
        <p className="state-hint">هنوز محاسبه‌ای برای این پیش‌نویس اجرا نشده است.</p>
      )}

      <h2 className="section-title">گزارش‌ها</h2>
      <div className="section-actions">
        <Button
          variant="secondary"
          busy={downloading === 'excel'}
          disabled={!isFinalized}
          onClick={() => {
            void download('excel');
          }}
        >
          دانلود Excel
        </Button>
        <Button
          variant="secondary"
          busy={downloading === 'pdf'}
          disabled={!isFinalized}
          onClick={() => {
            void download('pdf');
          }}
        >
          دانلود PDF
        </Button>
        {!isFinalized && (
          <span className="state-hint">گزارش‌ها فقط برای نسخه نهایی‌شده در دسترس‌اند.</span>
        )}
      </div>
      <FormError error={downloadError} />

      {adding && versionId !== undefined && (
        <AddLineDialog
          versionId={versionId}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            version.reload();
          }}
        />
      )}
      {confirming && versionId !== undefined && builtForFinalize.ok && (
        <FinalizeDialog
          versionId={versionId}
          coefficients={builtForFinalize.value}
          onClose={() => setConfirming(false)}
          onFinalized={() => {
            setConfirming(false);
            setCalculation(undefined);
            version.reload();
          }}
        />
      )}
    </section>
  );
}
