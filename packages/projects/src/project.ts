/**
 * The Project — the stable owner of estimates (ARCHITECTURE.md §4.4:
 * Organization → Project → Estimate → EstimateVersion).
 *
 * Identity is caller-supplied and validated here (UUID, branded through the domain id
 * module); this layer never generates ids, reads no clock and keeps no hidden state —
 * `createdAt` is a caller-supplied instant. A project is metadata only: every calculation
 * input lives in the estimate versions, so a project can never influence a number.
 */
import { type OrganizationId, type ProjectId, parseId, parseInstant } from '@costgenius/domain';
import { ProjectsError } from './errors.js';

export interface Project {
  readonly projectId: ProjectId;
  /** Owning organization when the deployment is multi-tenant (optional; single-tenant installations omit it). */
  readonly organizationId?: OrganizationId;
  readonly title: string;
  readonly metadata: Readonly<Record<string, string>>;
  /** Caller-supplied creation instant (ISO string; this layer reads no clock). */
  readonly createdAt: string;
}

export interface CreateProjectInput {
  /** UUID string; validated and branded as ProjectId here (generation belongs to the caller). */
  readonly projectId: string;
  readonly organizationId?: string;
  readonly title: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

/** Creates an immutable Project. All inputs are validated; nothing is defaulted. */
export function createProject(input: CreateProjectInput): Project {
  const projectId = parseId(input.projectId, 'ProjectId');
  const organizationId =
    input.organizationId !== undefined
      ? parseId(input.organizationId, 'OrganizationId')
      : undefined;
  if (typeof input.title !== 'string' || input.title.length === 0) {
    throw new ProjectsError('INVALID_PROJECT_INPUT', 'title must be a non-empty string');
  }
  if (typeof input.createdAt !== 'string' || input.createdAt.length === 0) {
    throw new ProjectsError('INVALID_PROJECT_INPUT', 'createdAt must be a non-empty string');
  }
  parseInstant(input.createdAt);
  return deepFreeze({
    projectId,
    ...(organizationId !== undefined ? { organizationId } : {}),
    title: input.title,
    metadata: { ...(input.metadata ?? {}) },
    createdAt: input.createdAt,
  });
}
