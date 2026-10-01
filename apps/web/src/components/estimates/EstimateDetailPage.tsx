/**
 * صفحه برآورد (§18): مشخصات برآورد + فهرست نسخه‌ها با وضعیت دقیق هر نسخه +
 * ایجاد نسخه جدید (تنها مسیر پیشروی بعد از نهایی‌شدن، §69).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../../api/context.js';
import { formatInstant, statusLabel } from '../../format.js';
import { useResource } from '../../hooks.js';
import type { PricebookEditionSummary } from '../../api/types.js';
import {
  Badge,
  Button,
  ErrorView,
  Field,
  FormError,
  LoadingView,
  Ltr,
  Modal,
  Select,
  TextInput,
  FormValidationError,
} from '../ui/primitives.js';

export function EstimateDetailPage(): ReactElement {
  const { estimateId } = useParams<{ estimateId: string }>();
  const api = useApi();
  const navigate = useNavigate();
  const estimate = useResource(() => {
    if (estimateId === undefined) return Promise.reject(new Error('نشانی برآورد نامعتبر است'));
    return api.getEstimate(estimateId);
  });
  const [creating, setCreating] = useState(false);

  if (estimate.loading) return <LoadingView />;
  if (estimate.error !== undefined)
    return <ErrorView error={estimate.error} onRetry={estimate.reload} />;
  if (estimate.data === undefined) return <ErrorView error={new Error('برآورد پیدا نشد.')} />;

  const data = estimate.data;

  return (
    <section aria-labelledby="estimate-title">
      <nav className="breadcrumb">
        <Link to="/projects" className="link">
          پروژه‌ها
        </Link>
        <span aria-hidden="true">›</span>
        <Link to={`/projects/${data.projectId}`} className="link">
          پروژه
        </Link>
        <span aria-hidden="true">›</span>
        <span>{data.title}</span>
      </nav>
      <div className="page-head">
        <h1 id="estimate-title">{data.title}</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          نسخه جدید
        </Button>
      </div>

      <div className="info-grid">
        <div className="info-row">
          <dt>شناسه برآورد</dt>
          <dd>
            <Ltr>{data.estimateId}</Ltr>
          </dd>
        </div>
        <div className="info-row">
          <dt>فهرست‌بها</dt>
          <dd>
            {data.versions.length === 0
              ? '—'
              : data.versions.some(
                    (v) => v.editionId !== undefined && v.editionId !== data.versions[0]?.editionId,
                  )
                ? 'بر اساس نسخه (نسخه‌ها می‌توانند فهرست‌بهای متفاوت داشته باشند)'
                : (data.versions[0]?.edition ?? '—')}
          </dd>
        </div>
        <div className="info-row">
          <dt>تعداد نسخه‌ها</dt>
          <dd>{data.versions.length}</dd>
        </div>
      </div>

      <h2 className="section-title">نسخه‌ها</h2>
      <ul className="card-list">
        {data.versions.map((version) => (
          <li key={version.versionId} className="card">
            <div className="card-main">
              <Link to={`/versions/${version.versionId}`} className="card-title">
                نسخه {version.versionNumber}
              </Link>
              <p className="card-sub">
                <Ltr>{version.edition}</Ltr>
                {version.editionId !== undefined && (
                  <>
                    {' '}
                    (<Ltr>{version.editionId}</Ltr>)
                  </>
                )}{' '}
                · {formatInstant(version.createdAt)}
                {version.buildingId !== undefined && <> · ساختمان: {version.buildingId}</>}
              </p>
            </div>
            <div className="card-side">
              <Badge tone={version.status === 'finalized' ? 'finalized' : 'draft'}>
                {statusLabel(version.status)}
              </Badge>
              <Link to={`/versions/${version.versionId}`} className="link">
                مشاهده
              </Link>
            </div>
          </li>
        ))}
      </ul>

      {creating && estimateId !== undefined && (
        <CreateVersionDialog
          estimateId={estimateId}
          defaultBuildingId={data.versions[0]?.buildingId}
          onClose={() => setCreating(false)}
          onCreated={(versionId) => {
            setCreating(false);
            estimate.reload();
            navigate(`/versions/${versionId}`);
          }}
        />
      )}
    </section>
  );
}

function CreateVersionDialog({
  estimateId,
  defaultBuildingId,
  onClose,
  onCreated,
}: {
  estimateId: string;
  defaultBuildingId: string | undefined;
  onClose: () => void;
  onCreated: (versionId: string) => void;
}): ReactElement {
  const api = useApi();
  const [buildingId, setBuildingId] = useState(defaultBuildingId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  // P8-B S3 (D-PB-3 = B, §19): the optional edition selector — default: the ACTIVE
  // edition; selectable: ACTIVE + ARCHIVED; DRAFT is never offered. The binding is
  // immutable once the version is created.
  const [editions, setEditions] = useState<readonly PricebookEditionSummary[] | undefined>(
    undefined,
  );
  const [editionId, setEditionId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .listEditions()
      .then((all) => {
        if (cancelled) return;
        const selectable = all.filter((edition) => edition.status !== 'DRAFT');
        setEditions(selectable);
        const active = selectable.find((edition) => edition.status === 'ACTIVE');
        setEditionId(active?.editionId ?? selectable[0]?.editionId);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const submit = async (): Promise<void> => {
    if (buildingId.trim().length === 0) {
      setError(new FormValidationError('شناسه ساختمان الزامی است (ورودی ضروری قرارداد نسخه).'));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const version = await api.createVersion(estimateId, {
        buildingId: buildingId.trim(),
        ...(editionId !== undefined ? { editionId } : {}),
      });
      onCreated(version.versionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setBusy(false);
    }
  };

  return (
    <Modal title="نسخه جدید" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="شناسه ساختمان *"
          hint="برای محاسبه ضریب مرحله، هر نسخه به یک ساختمان گره می‌خورد."
        >
          <TextInput
            value={buildingId}
            onChange={(event) => setBuildingId(event.target.value)}
            placeholder="building-main"
            autoFocus
          />
        </Field>
        <Field
          label="فهرست‌بها *"
          hint="نسخه به فهرست‌بهای انتخاب‌شده گره می‌خورد و پس از ایجاد تغییرپذیر نیست؛ پیش‌فرض فهرست‌بهای جاری (فعال) است."
        >
          {editions === undefined ? (
            <Select disabled>
              <option>در حال دریافت فهرست‌بها…</option>
            </Select>
          ) : (
            <Select
              value={editionId ?? ''}
              onChange={(event) => setEditionId(event.target.value)}
              disabled={editions.length === 0}
            >
              {editions.length === 0 && <option value="">فهرست‌بهای فعالی موجود نیست</option>}
              {editions.map((edition) => (
                <option key={edition.editionId} value={edition.editionId}>
                  {edition.title} ({edition.year})
                  {edition.status === 'ACTIVE' ? ' — جاری' : ' — بایگانی‌شده'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>لغو</Button>
          <Button variant="primary" type="submit" busy={busy}>
            ایجاد نسخه
          </Button>
        </div>
      </form>
    </Modal>
  );
}
