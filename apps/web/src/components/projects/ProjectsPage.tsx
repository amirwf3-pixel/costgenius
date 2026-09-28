/**
 * صفحه پروژه‌ها (§13/§14): فهرست پروژه‌های واقعی API + ایجاد پروژه جدید.
 * Empty/loading/error states are first-class; no fake data ever (§37).
 */
import { useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../../api/context.js';
import { formatInstant } from '../../format.js';
import { useResource } from '../../hooks.js';
import type { Project } from '../../api/types.js';
import {
  Button,
  EmptyView,
  ErrorView,
  Field,
  FormError,
  LoadingView,
  Modal,
  TextInput,
  FormValidationError,
} from '../ui/primitives.js';

export function ProjectsPage(): ReactElement {
  const api = useApi();
  const navigate = useNavigate();
  const projects = useResource(() => api.listProjects());
  const [creating, setCreating] = useState(false);

  return (
    <section aria-labelledby="projects-title">
      <div className="page-head">
        <h1 id="projects-title">پروژه‌ها</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          + پروژه جدید
        </Button>
      </div>

      {projects.loading && <LoadingView />}
      {!projects.loading && projects.error !== undefined && (
        <ErrorView error={projects.error} onRetry={projects.reload} />
      )}
      {!projects.loading && projects.error === undefined && projects.data?.length === 0 && (
        <EmptyView
          title="هنوز پروژه‌ای وجود ندارد."
          hint="برای شروع برآورد، نخستین پروژه را ایجاد کنید."
        />
      )}
      {!projects.loading &&
        projects.error === undefined &&
        projects.data !== undefined &&
        projects.data.length > 0 && (
          <ul className="card-list">
            {projects.data.map((project) => (
              <ProjectCard key={project.projectId} project={project} />
            ))}
          </ul>
        )}

      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(projectId) => {
            setCreating(false);
            projects.reload();
            navigate(`/projects/${projectId}`);
          }}
        />
      )}
    </section>
  );
}

function ProjectCard({ project }: { project: Project }): ReactElement {
  const metadataKeys = Object.keys(project.metadata);
  return (
    <li className="card">
      <div className="card-main">
        <Link to={`/projects/${project.projectId}`} className="card-title">
          {project.title}
        </Link>
        <p className="card-sub">
          {metadataKeys.length > 0
            ? metadataKeys.map((key) => `${key}: ${project.metadata[key] ?? ''}`).join(' · ')
            : 'بدون توضیح'}
        </p>
      </div>
      <div className="card-side">
        <span className="card-date">{formatInstant(project.createdAt)}</span>
        <Link to={`/projects/${project.projectId}`} className="link">
          مشاهده برآوردها
        </Link>
      </div>
    </li>
  );
}

function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (projectId: string) => void;
}): ReactElement {
  const api = useApi();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const submit = async (): Promise<void> => {
    if (title.trim().length === 0) {
      setError(new FormValidationError('عنوان پروژه الزامی است.'));
      return;
    }
    setBusy(true);
    setError(undefined);
    // metadata: only the keys the user actually filled (string→string per the contract)
    const metadata: Record<string, string> = {};
    if (description.trim().length > 0) metadata['description'] = description.trim();
    if (location.trim().length > 0) metadata['location'] = location.trim();
    try {
      const project = await api.createProject({ title: title.trim(), metadata });
      onCreated(project.projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setBusy(false);
    }
  };

  return (
    <Modal title="پروژه جدید" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="عنوان پروژه *">
          <TextInput
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="مثلاً ساختمان اداری فاز ۱"
            autoFocus
          />
        </Field>
        <Field label="محل (اختیاری)">
          <TextInput
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="تهران"
          />
        </Field>
        <Field label="توضیح (اختیاری)">
          <TextInput
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="مرحله اول"
          />
        </Field>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>لغو</Button>
          <Button variant="primary" type="submit" busy={busy}>
            ایجاد پروژه
          </Button>
        </div>
      </form>
    </Modal>
  );
}
