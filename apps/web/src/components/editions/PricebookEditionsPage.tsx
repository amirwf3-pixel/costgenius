/**
 * P8-B S4 — the steward-facing «فهرست‌بهاها» management page (CG-IR-PRICEBOOK-SPEC@
 * 0.2.0 §19 bullet 1). A pure management surface over the EXISTING verified backend
 * routes — #39 list, #41 import, #42 activate, #43 archive; no authorization logic
 * lives here: the backend remains the authoritative security boundary, and the role
 * check below is navigation/actions UX only (a denied direct call still answers 403).
 *
 * Lifecycle semantics are the API's: a rejected import stores NOTHING and writes no
 * audit event (rendered verbatim from the API's structured failures); activation is
 * four-eyes-enforced server-side; archiving the only ACTIVE edition is legal (the
 * 0-active state, D-PB-4 = A). The page never fabricates lifecycle state locally —
 * every mutation's result comes from the API and the list is re-fetched afterwards.
 */
import { useState, type ChangeEvent, type ReactElement } from 'react';
import { useApi } from '../../api/context.js';
import { ApiError, editionImportFailures } from '../../api/client.js';
import { useSession } from '../auth/AuthenticatedApp.js';
import { formatInstant } from '../../format.js';
import { useResource } from '../../hooks.js';
import type {
  ImportIssueView,
  ImportReportView,
  PricebookEditionSummary,
} from '../../api/types.js';
import {
  Badge,
  Button,
  EmptyView,
  ErrorView,
  Field,
  FormError,
  FormValidationError,
  LoadingView,
  Ltr,
  Modal,
} from '../ui/primitives.js';

/** The §19 status labels (mapped onto the existing badge tones). */
function editionStatusTone(status: PricebookEditionSummary['status']): {
  tone: 'draft' | 'finalized' | 'neutral';
  label: string;
} {
  switch (status) {
    case 'ACTIVE':
      return { tone: 'finalized', label: 'جاری (فعال)' };
    case 'ARCHIVED':
      return { tone: 'neutral', label: 'بایگانی‌شده' };
    default:
      return { tone: 'draft', label: 'پیش‌نویس' };
  }
}

/** The first 12 hex chars — the §19 «short contentHash» (full hash on hover). */
function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/** Reads the picked file as UTF-8 text (FileReader — universally supported). */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsText always resolves to a string — the guard narrows the DOM type
      const result = reader.result;
      resolve(typeof result === 'string' ? result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('reading the file failed'));
    };
    reader.readAsText(file);
  });
}

export function PricebookEditionsPage(): ReactElement {
  const api = useApi();
  const session = useSession();
  const editions = useResource(() => api.listEditions());
  // P8-B S4 §1: the mutation surface is visible to the two pipeline roles only —
  // UX, never authorization (the backend route policy is the security boundary).
  const canManage = session.role === 'data_steward' || session.role === 'org_admin';
  const [importing, setImporting] = useState(false);
  const [confirmingActivate, setConfirmingActivate] = useState<PricebookEditionSummary | null>(
    null,
  );
  const [confirmingArchive, setConfirmingArchive] = useState<PricebookEditionSummary | null>(null);
  const [pendingEditionId, setPendingEditionId] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<Error | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  /** Runs a lifecycle command: pending state, API result, list refresh, feedback. */
  const runCommand = async (
    edition: PricebookEditionSummary,
    command: (editionId: string) => Promise<PricebookEditionSummary>,
    successText: (edition: PricebookEditionSummary) => string,
  ): Promise<void> => {
    setPendingEditionId(edition.editionId);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const updated = await command(edition.editionId);
      setNotice(successText(updated));
      editions.reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setPendingEditionId(undefined);
    }
  };

  return (
    <section aria-labelledby="editions-title">
      <div className="page-head">
        <h1 id="editions-title">فهرست‌بهاها</h1>
        {canManage && (
          <Button variant="primary" onClick={() => setImporting(true)}>
            + درون‌ریزی فهرست‌بها
          </Button>
        )}
      </div>

      {notice !== undefined && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {actionError !== undefined && <FormError error={actionError} />}

      {editions.loading && <LoadingView />}
      {!editions.loading && editions.error !== undefined && (
        <ErrorView error={editions.error} onRetry={editions.reload} />
      )}
      {!editions.loading && editions.error === undefined && (editions.data?.length ?? 0) === 0 && (
        <EmptyView
          title="هنوز فهرست‌بهایی ثبت نشده است."
          hint="فهرست‌بهاها از طریق درون‌ریزی سند پلکانی JSON وارد و سپس فعال می‌شوند."
        />
      )}
      {!editions.loading && editions.error === undefined && (editions.data?.length ?? 0) > 0 && (
        <ul className="card-list" aria-label="فهرست نسخه‌های فهرست‌بها">
          {editions.data?.map((edition) => (
            <EditionCard
              key={edition.editionId}
              edition={edition}
              canManage={canManage}
              busy={pendingEditionId === edition.editionId}
              actionsDisabled={pendingEditionId !== undefined}
              onActivate={() => {
                setActionError(undefined);
                setConfirmingActivate(edition);
              }}
              onArchive={() => {
                setActionError(undefined);
                setConfirmingArchive(edition);
              }}
            />
          ))}
        </ul>
      )}

      {importing && (
        <ImportEditionDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            editions.reload();
          }}
        />
      )}
      {confirmingActivate !== null && (
        <ConfirmActivateDialog
          edition={confirmingActivate}
          onClose={() => setConfirmingActivate(null)}
          onConfirm={() => {
            const target = confirmingActivate;
            setConfirmingActivate(null);
            void runCommand(
              target,
              (editionId) => api.activateEdition(editionId),
              (updated) =>
                `فهرست‌بهای «${updated.title}» فعال شد؛ فهرست‌بهای جاری قبلی (در صورت وجود) بایگانی شد و نسخه‌های جدید از این پس به‌طور پیش‌فرض به همین فهرست‌بها گره می‌خورند.`,
            );
          }}
        />
      )}
      {confirmingArchive !== null && (
        <ConfirmArchiveDialog
          edition={confirmingArchive}
          onClose={() => setConfirmingArchive(null)}
          onConfirm={() => {
            const target = confirmingArchive;
            setConfirmingArchive(null);
            void runCommand(
              target,
              (editionId) => api.archiveEdition(editionId),
              (updated) => `فهرست‌بهای «${updated.title}» بایگانی شد.`,
            );
          }}
        />
      )}
    </section>
  );
}

/** One edition row of the #39 list — every §19 field, straight from the API. */
function EditionCard({
  edition,
  canManage,
  busy,
  actionsDisabled,
  onActivate,
  onArchive,
}: {
  edition: PricebookEditionSummary;
  canManage: boolean;
  busy: boolean;
  actionsDisabled: boolean;
  onActivate: () => void;
  onArchive: () => void;
}): ReactElement {
  const status = editionStatusTone(edition.status);
  return (
    <li className="card">
      <div className="card-main">
        <div className="card-title-row">
          <span className="card-title">
            {edition.title} ({edition.year})
          </span>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <dl className="info-grid" aria-label="مشخصات فهرست‌بها">
          <div className="info-row">
            <dt>شماره/تاریخ اطلاعیه</dt>
            <dd>
              {edition.notificationNumber !== null ? (
                <>
                  <Ltr>{edition.notificationNumber}</Ltr>
                  {edition.notificationDate !== null && (
                    <> — {formatInstant(edition.notificationDate)}</>
                  )}
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div className="info-row">
            <dt>اثر انگشت محتوا</dt>
            <dd>
              <Ltr>
                <span title={edition.contentHash}>{shortHash(edition.contentHash)}</span>
              </Ltr>
            </dd>
          </div>
          <div className="info-row">
            <dt>تعداد ردیف‌ها</dt>
            <dd>
              <Ltr>{String(edition.rowCount)}</Ltr>
            </dd>
          </div>
          <div className="info-row">
            <dt>درون‌ریزی</dt>
            <dd>
              <Ltr>{shortHash(edition.importedBy)}</Ltr> — {formatInstant(edition.importedAt)}
            </dd>
          </div>
          <div className="info-row">
            <dt>فعال‌سازی</dt>
            <dd>{edition.activatedAt !== null ? formatInstant(edition.activatedAt) : '—'}</dd>
          </div>
          <div className="info-row">
            <dt>بایگانی</dt>
            <dd>{edition.archivedAt !== null ? formatInstant(edition.archivedAt) : '—'}</dd>
          </div>
        </dl>
      </div>
      {canManage && (
        <div className="card-side">
          {edition.status !== 'ACTIVE' && (
            <Button variant="primary" onClick={onActivate} disabled={actionsDisabled} busy={busy}>
              فعال‌سازی
            </Button>
          )}
          {edition.status !== 'ARCHIVED' && (
            <Button variant="danger" onClick={onArchive} disabled={actionsDisabled} busy={busy}>
              بایگانی
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** The #41 import dialog: a file picker for the staged JSON + the inline report. */
function ImportEditionDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}): ReactElement {
  const api = useApi();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [failures, setFailures] = useState<readonly ImportIssueView[] | undefined>(undefined);
  const [report, setReport] = useState<ImportReportView | undefined>(undefined);

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    setFile(event.target.files?.[0]);
    setError(undefined);
    setFailures(undefined);
    setReport(undefined);
  };

  const submit = async (): Promise<void> => {
    if (file === undefined) {
      setError(new FormValidationError('ابتدا پروندهٔ JSON فهرست‌بها را انتخاب کنید.'));
      return;
    }
    setBusy(true);
    setError(undefined);
    setFailures(undefined);
    try {
      const text = await readFileText(file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        setBusy(false);
        setError(new FormValidationError('پروندهٔ انتخاب‌شده JSON معتبر نیست.'));
        return;
      }
      const result = await api.importEdition(parsed);
      setReport(result.importReport);
    } catch (cause) {
      // the API guarantee rendered verbatim: a rejected import stored NOTHING and
      // wrote no audit event (422 PRICEBOOK_IMPORT_REJECTED with details.failures)
      if (cause instanceof ApiError) {
        setError(cause);
        setFailures(editionImportFailures(cause.details));
      } else {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="درون‌ریزی فهرست‌بها" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="پروندهٔ سند پلکانی (JSON) *"
          hint="سند پلکانی فهرست‌بها (formatVersion 1)؛ اعتبارسنجی و ذخیره‌سازی روی سرور و در یک تراکنش انجام می‌شود."
        >
          <input
            type="file"
            accept=".json,application/json"
            className="input"
            aria-label="پروندهٔ سند پلکانی فهرست‌بها"
            onChange={onPick}
            disabled={busy}
            autoFocus
          />
        </Field>
        {error !== undefined && <FormError error={error} />}
        {failures !== undefined && failures.length > 0 && (
          <div className="report-block" role="alert" aria-label="خطاهای اعتبارسنجی درون‌ریزی">
            <p className="report-head">
              خطاهای اعتبارسنجی (هیچ چیزی ذخیره نشد و هیچ رویداد حسابرسی ثبت نشد):
            </p>
            <ul className="issue-list">
              {failures.map((issue, index) => (
                <li key={`${issue.code}-${String(index)}`}>
                  <Ltr>
                    {issue.code}
                    {issue.rowCode !== undefined && ` (${issue.rowCode})`}
                  </Ltr>{' '}
                  — {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {report !== undefined && (
          <div className="report-block" role="status" aria-label="گزارش درون‌ریزی">
            <p className="report-head">
              درون‌ریزی پذیرفته شد: فهرست‌بهای «{report.editionId}» با{' '}
              <Ltr>{String(report.rowCount)}</Ltr> ردیف به‌صورت پیش‌نویس ثبت شد (هنوز فعال نیست).
            </p>
            {report.warningCount > 0 && (
              <ul className="issue-list" aria-label="هشدارهای درون‌ریزی">
                {report.warnings.map((issue, index) => (
                  <li key={`warning-${issue.code}-${String(index)}`}>
                    <Ltr>
                      {issue.code}
                      {issue.rowCode !== undefined && ` (${issue.rowCode})`}
                    </Ltr>{' '}
                    — {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="form-row">
          <Button type="submit" variant="primary" busy={busy} disabled={file === undefined}>
            درون‌ریزی
          </Button>
          {report === undefined ? (
            <Button onClick={onClose} disabled={busy}>
              انصراف
            </Button>
          ) : (
            <Button variant="primary" onClick={onImported}>
              نوسازی فهرست
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** The #42 activation confirmation — the three §19 statements, verbatim. */
function ConfirmActivateDialog({
  edition,
  onClose,
  onConfirm,
}: {
  edition: PricebookEditionSummary;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  return (
    <Modal title="فعال‌سازی فهرست‌بها" onClose={onClose}>
      <p>
        آیا از فعال‌سازی فهرست‌بهای «{edition.title} ({edition.year})» مطمئنید؟
      </p>
      <ul>
        <li>این فهرست‌بها جاری (فعال) می‌شود.</li>
        <li>فهرست‌بهای جاری قبلی (در صورت وجود) بایگانی خواهد شد.</li>
        <li>
          نسخه‌های جدید برآورد از این پس به‌طور پیش‌فرض به همین فهرست‌بها (به‌جای فهرست‌بهای قبلی)
          گره می‌خورند.
        </li>
      </ul>
      <div className="form-row">
        <Button variant="primary" onClick={onConfirm} autoFocus>
          فعال‌سازی
        </Button>
        <Button onClick={onClose}>انصراف</Button>
      </div>
    </Modal>
  );
}

/** The #43 archive confirmation. */
function ConfirmArchiveDialog({
  edition,
  onClose,
  onConfirm,
}: {
  edition: PricebookEditionSummary;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  return (
    <Modal title="بایگانی فهرست‌بها" onClose={onClose}>
      <p>
        آیا از بایگانی فهرست‌بهای «{edition.title} ({edition.year})» مطمئنید؟
        {edition.status === 'ACTIVE' &&
          ' بایگانیِ تنها فهرست‌بهای جاری، وضعیت «بدون فهرست‌بهای فعال» را ایجاد می‌کند (تا فعال‌سازی بعدی).'}
      </p>
      <div className="form-row">
        <Button variant="danger" onClick={onConfirm} autoFocus>
          بایگانی
        </Button>
        <Button onClick={onClose}>انصراف</Button>
      </div>
    </Modal>
  );
}
