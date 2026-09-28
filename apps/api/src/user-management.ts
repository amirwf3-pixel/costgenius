/**
 * User management (P8-A S2, CG-GOV-SPEC@0.1.0 §2.3) — the org_admin surface: create,
 * list, change role, deactivate. Lives at the API boundary beside `auth.ts` (same
 * layer, same rules): password material exists only here (scrypt via `hashPassword`)
 * and NEVER leaves this module in a response. Authorization is NOT decided here —
 * the route gate (`authz.ts`) has already verified the caller is org_admin; this
 * module enforces the §2.3 GUARD RAILS that depend on the target, not the route:
 * self-deactivation (403) and the last-active-org_admin lockout (409).
 *
 * Deactivation is soft (CG-GOV §2.3): the users row is never deleted, every session
 * of the user is revoked, and there is no activate route in V1.1.
 */
import { randomUUID } from 'node:crypto';
import type { User, UserRole } from '@costgenius/projects';
import { hashPassword, isValidPassword, normalizeUsername, type AuthDependencies } from './auth.js';

/** The §2.3/§8 user-management error codes (status decided by `errors.ts`). */
export type UserManagementErrorCode =
  'USERNAME_ALREADY_TAKEN' | 'USER_NOT_FOUND' | 'CANNOT_DEACTIVATE_LAST_ORG_ADMIN' | 'FORBIDDEN';

export class UserManagementError extends Error {
  readonly code: UserManagementErrorCode;

  constructor(code: UserManagementErrorCode, message: string) {
    super(message);
    this.name = 'UserManagementError'; // stable discriminator for the error mapper
    this.code = code;
  }
}

/** What any user route may return — the full profile minus the password hash. */
export type PublicUser = Omit<User, 'passwordHash'>;

function publicUser(user: User): PublicUser {
  return {
    userId: user.userId,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}

/**
 * Create (CG-GOV §2.3): `POST /users {username, password, role}` → 201, no password
 * material in the response. The payload's shape (username pattern, 8–128 password,
 * the five-role enum) was already validated by the route schema; this function owns
 * the SEMANTIC rule — a duplicate (case-insensitively stored, lowercase-only) username
 * answers 409 USERNAME_ALREADY_TAKEN.
 */
export async function createUser(
  deps: AuthDependencies,
  input: { username: string; password: string; role: UserRole },
): Promise<PublicUser> {
  const username = normalizeUsername(input.username);
  if (username === undefined || !isValidPassword(input.password)) {
    // unreachable behind the route schema — kept fall-closed, never a silent pass
    throw new UserManagementError(
      'USERNAME_ALREADY_TAKEN',
      'the username or password does not satisfy the account rules',
    );
  }
  const existing = await deps.users.findByUsername(username);
  if (existing !== undefined) {
    throw new UserManagementError(
      'USERNAME_ALREADY_TAKEN',
      'a user with this username already exists',
    );
  }
  const user: User = {
    userId: randomUUID(),
    username,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    isActive: true,
    createdAt: deps.clock(),
  };
  await deps.users.save(user);
  return publicUser(user);
}

/** List (CG-GOV §2.3): every account, deterministic store order, no hashes. */
export async function listUsers(deps: AuthDependencies): Promise<PublicUser[]> {
  return (await deps.users.list()).map(publicUser);
}

async function requireUser(deps: AuthDependencies, userId: string): Promise<User> {
  const user = await deps.users.findById(userId);
  if (user === undefined) {
    throw new UserManagementError('USER_NOT_FOUND', `no user with id "${userId}" exists`);
  }
  return user;
}

/**
 * Change role (CG-GOV §2.3): `POST /users/:userId/role {role}` → 200. Guard rail: an
 * ACTIVE org_admin may not be demoted while they are the LAST active org_admin — the
 * instance must never lock itself out (§1.5 bootstrap does not re-run; 409
 * CANNOT_DEACTIVATE_LAST_ORG_ADMIN). Changing to the same role is an idempotent 200.
 */
export async function changeUserRole(
  deps: AuthDependencies,
  userId: string,
  role: UserRole,
): Promise<PublicUser> {
  const user = await requireUser(deps, userId);
  if (user.isActive && user.role === 'org_admin' && role !== 'org_admin') {
    const activeAdmins = await deps.users.countActiveByRole('org_admin');
    if (activeAdmins <= 1) {
      throw new UserManagementError(
        'CANNOT_DEACTIVATE_LAST_ORG_ADMIN',
        'the last active org_admin cannot be deactivated or demoted (the instance must keep an active administrator)',
      );
    }
  }
  if (user.role !== role) {
    await deps.users.updateRole(userId, role);
  }
  return publicUser({ ...user, role });
}

/**
 * Deactivate (CG-GOV §2.3): `POST /users/:userId/deactivate` → 200. Soft — the row
 * stays (append-only posture), `is_active` flips, and EVERY session of the user is
 * revoked. Guard rails: you cannot deactivate your own account (403 FORBIDDEN), and
 * the last active org_admin cannot be deactivated (409). Deactivating an
 * already-inactive account is an idempotent 200.
 */
export async function deactivateUser(
  deps: AuthDependencies,
  actorUserId: string,
  userId: string,
): Promise<PublicUser> {
  const user = await requireUser(deps, userId);
  if (user.userId === actorUserId) {
    throw new UserManagementError('FORBIDDEN', 'you cannot deactivate your own account');
  }
  if (user.isActive && user.role === 'org_admin') {
    const activeAdmins = await deps.users.countActiveByRole('org_admin');
    if (activeAdmins <= 1) {
      throw new UserManagementError(
        'CANNOT_DEACTIVATE_LAST_ORG_ADMIN',
        'the last active org_admin cannot be deactivated or demoted (the instance must keep an active administrator)',
      );
    }
  }
  if (user.isActive) {
    await deps.users.updateIsActive(userId, false);
    await deps.sessions.deleteAllByUser(userId);
  }
  return publicUser({ ...user, isActive: false });
}
