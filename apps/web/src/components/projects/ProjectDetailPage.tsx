/**
 * صفحه پروژه (§15): مشخصات پروژه + فهرست برآوردهای واقعی آن + ایجاد برآورد.
 * پروژه‌ها در دامنه تغییرناپذیرند — دکمه ویرایش وجود ندارد (§15).
 */
import { useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../../api/context.js';
import { formatInstant } from '../../format.js';
import { useResource } from '../../hooks.js';
import { takeoffStatusLabel } from '../takeoff/model.js';
import {
  Badge,
  Button,
  EmptyView,
  ErrorView,
  Field,
  FormError,
  LoadingView,
  Ltr,
  Modal,
  TextInput,
  FormValidationError,
} from '../ui/primitives.js';

export function ProjectDetailPage(): ReactElement {
  const { projectId } = useParams<{ projectId: string }>();
  const api = useApi();
  const project = useResource(() => {
    if (projectId === undefined) return Promise.reject(new Error('نشانی پروژه نامعتبر است'));
    return api.getProject(projectId);
  });
  const estimates = useResource(() => {
    if (projectId === undefined) return Promise.reject(new Error('نشانی پروژه نامعتبر است'));
    return api.listEstimates(projectId);
  });
  // P7-S1 (CG-FT@0.2.0 §15): فهرست اسناد صورت‌برداشت پروژه — projection از API.
  const takeoffs = useResource(() => {
    if (projectId === undefined) return Promise.reject(new Error('نشانی پروژه نامعتبر است'));
    return api.listTakeoffs(projectId);
  });
  const [creating, setCreating] = useState(false);
  const [creatingTakeoff, setCreatingTakeoff] = useState(false);
  const navigate = useNavigate();

  if (project.loading) return <LoadingView />;
  if (project.error !== undefined)
    return <ErrorView error={project.error} onRetry={project.reload} />;
  if (project.data === undefined) return <EmptyView title="پروژه پیدا نشد." />;

  return (
    <section aria-labelledby="project-title">
      <nav className="breadcrumb">
        <Link to="/projects" className="link">
          پروژه‌ها
        </Link>
        <span aria-hidden="true">›</span>
        <span>{project.data.title}</span>
      </nav>
      <div className="page-head">
        <h1 id="project-title">{project.data.title}</h1>
        <div className="page-head-actions">
          <Button onClick={() => setCreatingTakeoff(true)}>+ صورت‌برداشت جدید</Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            + برآورد جدید
          </Button>
        </div>
      </div>

      <div className="info-grid">
        <InfoRow label="شناسه پروژه">
          <Ltr>{project.data.projectId}</Ltr>
        </InfoRow>
        <InfoRow label="تاریخ ایجاد">{formatInstant(project.data.createdAt)}</InfoRow>
        {Object.entries(project.data.metadata).map(([key, value]) => (
          <InfoRow key={key} label={key}>
            {value}
          </InfoRow>
        ))}
      </div>

      <h2 className="section-title">برآوردها</h2>
      {estimates.loading && <LoadingView />}
      {estimates.error !== undefined && (
        <ErrorView error={estimates.error} onRetry={estimates.reload} />
      )}
      {!estimates.loading && estimates.error === undefined && estimates.data?.length === 0 && (
        <EmptyView
          title="هنوز برآوردی برای این پروژه وجود ندارد."
          hint="برای شروع، یک برآورد جدید بسازید."
        />
      )}
      {estimates.data !== undefined && estimates.data.length > 0 && (
        <ul className="card-list">
          {estimates.data.map((estimate) => {
            const latest = estimate.versions[estimate.versions.length - 1];
            return (
              <li key={estimate.estimateId} className="card">
                <div className="card-main">
                  <Link to={`/estimates/${estimate.estimateId}`} className="card-title">
                    {estimate.title}
                  </Link>
                  <p className="card-sub">
                    نسخه‌ها: {estimate.versions.length}
                    {latest !== undefined && (
                      <> · آخرین نسخه: {latest.status === 'finalized' ? 'نهایی' : 'پیش‌نویس'}</>
                    )}
                  </p>
                </div>
                <div className="card-side">
                  {latest !== undefined && (
                    <Link to={`/versions/${latest.versionId}`} className="link">
                      مشاهده نسخه جاری
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="section-title">صورت‌برداشت‌ها (متره)</h2>
      {takeoffs.loading && <LoadingView />}
      {takeoffs.error !== undefined && (
        <ErrorView error={takeoffs.error} onRetry={takeoffs.reload} />
      )}
      {!takeoffs.loading && takeoffs.error === undefined && takeoffs.data?.length === 0 && (
        <EmptyView
          title="هنوز سند صورت‌برداشتی برای این پروژه وجود ندارد."
          hint="برای شروع، یک صورت‌برداشت جدید بسازید."
        />
      )}
      {projectId !== undefined && takeoffs.data !== undefined && takeoffs.data.length > 0 && (
        <ul className="card-list">
          {takeoffs.data.map((row) => (
            <li key={row.documentId} className="card">
              <div className="card-main">
                <Link
                  to={`/projects/${projectId}/takeoffs/${row.documentId}`}
                  className="card-title"
                >
                  {row.title}
                </Link>
                <p className="card-sub">
                  زنجیره: <Ltr>{row.takeoffId}</Ltr> · سند شمارهٔ{' '}
                  <Ltr>{String(row.documentNumber)}</Ltr> · وضعیت: {takeoffStatusLabel(row.status)}
                  {row.status === 'finalized' && row.finalizedAt !== undefined && (
                    <> · نهایی‌سازی: {formatInstant(row.finalizedAt)}</>
                  )}
                </p>
              </div>
              <div className="card-side">
                <Badge
                  tone={
                    row.status === 'draft'
                      ? 'draft'
                      : row.status === 'finalized'
                        ? 'finalized'
                        : 'neutral'
                  }
                >
                  {takeoffStatusLabel(row.status)}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
      {projectId !== undefined && (
        <OpenTakeoffForm onOpen={(id) => navigate(`/projects/${projectId}/takeoffs/${id}`)} />
      )}

      {creatingTakeoff && projectId !== undefined && (
        <CreateTakeoffDialog
          projectId={projectId}
          onClose={() => setCreatingTakeoff(false)}
          onCreated={(documentId) => {
            setCreatingTakeoff(false);
            navigate(`/projects/${projectId}/takeoffs/${documentId}`);
          }}
        />
      )}
      {creating && projectId !== undefined && (
        <CreateEstimateDialog
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            estimates.reload();
          }}
        />
      )}
    </section>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: ReactElement | string;
}): ReactElement {
  return (
    <div className="info-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CreateEstimateDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (estimateId: string) => void;
}): ReactElement {
  const api = useApi();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const submit = async (): Promise<void> => {
    if (title.trim().length === 0) {
      setError(new FormValidationError('عنوان برآورد الزامی است.'));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const estimate = await api.createEstimate(projectId, { title: title.trim() });
      onCreated(estimate.estimateId);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setBusy(false);
    }
  };

  return (
    <Modal title="برآورد جدید" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="عنوان برآورد *">
          <TextInput
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="مثلاً برآورد اولیه"
            autoFocus
          />
        </Field>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>لغو</Button>
          <Button variant="primary" type="submit" busy={busy}>
            ایجاد برآورد
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** بازکردن سند صورت‌برداشت موجود با شناسهٔ سند (سند فهرست‌شدنی وجود ندارد). */
function OpenTakeoffForm({ onOpen }: { onOpen: (documentId: string) => void }): ReactElement {
  const [documentId, setDocumentId] = useState('');
  return (
    <form
      className="form form-inline"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = documentId.trim();
        if (trimmed !== '') onOpen(trimmed);
      }}
    >
      <Field label="شناسهٔ سند صورت‌برداشت">
        <TextInput
          value={documentId}
          dir="ltr"
          aria-label="شناسهٔ سند صورت‌برداشت"
          placeholder="مثلاً 11111111-2222-3333-4444-555555555555"
          onChange={(event) => {
            setDocumentId(event.target.value);
          }}
        />
      </Field>
      <Button type="submit" disabled={documentId.trim() === ''}>
        بازکردن سند
      </Button>
    </form>
  );
}

function CreateTakeoffDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (documentId: string) => void;
}): ReactElement {
  const api = useApi();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const submit = async (): Promise<void> => {
    if (title.trim().length === 0) {
      setError(new FormValidationError('عنوان سند صورت‌برداشت الزامی است.'));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // شناسهٔ زنجیره و سند سمت کلاینت ساخته می‌شوند (قرارداد Phase 3)
      const document = await api.createTakeoff(projectId, { title: title.trim() });
      onCreated(document.documentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setBusy(false);
    }
  };

  return (
    <Modal title="سند صورت‌برداشت جدید" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="عنوان سند *">
          <TextInput
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="مثلاً متره مرحله اول"
            autoFocus
          />
        </Field>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>لغو</Button>
          <Button variant="primary" type="submit" busy={busy}>
            ایجاد سند
          </Button>
        </div>
      </form>
    </Modal>
  );
}
