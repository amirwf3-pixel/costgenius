/**
 * Real-PostgreSQL verification of the S3 DB-level guarantees (env-gated, CG-GOV
 * §4.2/§7.3) — the guarantees PGlite CANNOT prove, because PGlite runs as the single
 * embedded superuser where a REVOKE cannot bind:
 *
 * - **Append-only at the database level**: a dedicated non-owner application role
 *   (exactly the DEPLOYMENT.md runbook posture) can INSERT into `audit_events` but
 *   UPDATE and DELETE are denied with PostgreSQL 42501. The migration's
 *   `REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC` (0002_p8_governance) binds
 *   every role except the table owner/superuser; the runbook grants the application
 *   role full table access and then revokes exactly the audit UPDATE/DELETE.
 *
 * - **Same-transaction atomicity on a real server**: a mutation and its audit event
 *   commit or roll back together through the production Drizzle repositories over
 *   node-postgres (real BEGIN/SAVEPOINT/ROLLBACK), in both directions.
 *
 * GATED BY ENVIRONMENT: runs only when `COSTGENIUS_SMOKE_DATABASE_URL` is set (a
 * disposable database). When absent the suite is SKIPPED and never reported passed.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb, createDbPool, migrateDatabase, type DbClient } from '@costgenius/db';
import { createProject, projectCreated, type Actor } from '@costgenius/projects';
import { appendAuditEvent } from '../src/audit.js';
import { bindRepositories, transactOver } from './helpers.js';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;
const INSTANT = '2026-01-01T00:00:00Z';

/**
 * The dedicated non-owner application role of the runbook — a fresh name per run
 * (roles are cluster-wide, and the disposable database is re-used by later passes).
 */
const APP_ROLE = `cg_app_probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const APP_ROLE_PASSWORD = 'cg-app-probe-password-123';

describe.skipIf(SMOKE_URL === undefined)('S3 audit DB-level guarantees (real PostgreSQL)', () => {
  it('the application role may INSERT but never UPDATE or DELETE audit_events', async () => {
    const ownerPool = createDbPool(SMOKE_URL as string);
    try {
      const db: DbClient = createDb(ownerPool);
      await migrateDatabase(db, MIGRATIONS_FOLDER);

      // The DEPLOYMENT.md runbook, executed by the DBA/owner exactly as documented:
      // a login role with full table access — except the audit history's
      // UPDATE/DELETE, which stay revoked (append-only for the application).
      await ownerPool.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      await ownerPool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
      await ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      await ownerPool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
      );
      await ownerPool.query(`REVOKE UPDATE, DELETE ON TABLE audit_events FROM ${APP_ROLE}`);

      // Connect AS the application role (the URL's credentials swapped, nothing else).
      const url = new URL(SMOKE_URL as string);
      url.username = APP_ROLE;
      url.password = APP_ROLE_PASSWORD;
      const appPool = createDbPool(url.toString());
      try {
        // INSERT is allowed — the audit writer's only operation.
        const eventId = randomUUID();
        const inserted = await appPool.query(
          'INSERT INTO audit_events (event_id, at, actor_user_id, action, resource_type, resource_id, project_id, details) VALUES ($1, $2, NULL, $3, $4, $5, NULL, $6)',
          [eventId, INSTANT, 'auth.login_failed', 'user', 'append-only-probe', '{}'],
        );
        expect(inserted.rowCount).toBe(1);

        const pgErrorCode = (error: unknown): string => {
          if (typeof error === 'object' && error !== null && 'code' in error) {
            const code = (error as { code?: unknown }).code;
            if (typeof code === 'string') return code;
          }
          return 'no-code';
        };
        // UPDATE is denied at the database level (42501 permission denied).
        const updated = await appPool
          .query('UPDATE audit_events SET action = $1 WHERE event_id = $2', [
            'tampered.action',
            eventId,
          ])
          .then(() => 'unexpectedly-allowed', pgErrorCode);
        expect(updated).toBe('42501');

        // DELETE is denied at the database level too.
        const deleted = await appPool
          .query('DELETE FROM audit_events WHERE event_id = $1', [eventId])
          .then(() => 'unexpectedly-allowed', pgErrorCode);
        expect(deleted).toBe('42501');

        // the row is intact — history cannot be rewritten through the application role
        const intact = await ownerPool.query(
          'SELECT action FROM audit_events WHERE event_id = $1',
          [eventId],
        );
        expect(intact.rows[0]).toEqual({ action: 'auth.login_failed' });

        // sanity: the role is otherwise a normal application role (projects are writable)
        const projectId = randomUUID();
        const projectWritten = await appPool.query(
          'INSERT INTO projects (project_id, title, metadata, created_at) VALUES ($1, $2, $3, $4)',
          [projectId, 'runbook-sanity', JSON.stringify({}), INSTANT],
        );
        expect(projectWritten.rowCount).toBe(1);
      } finally {
        await appPool.end();
      }
    } finally {
      // roles are cluster-wide: release the granted privileges, then drop the role
      // (the disposable database keeps its rows — history is never rewritten)
      try {
        await ownerPool.query(`DROP OWNED BY ${APP_ROLE}`);
        await ownerPool.query(`DROP ROLE ${APP_ROLE}`);
      } catch {
        // best effort only — the database and its cluster are disposable
      }
      await ownerPool.end();
    }
  });

  it('a mutation and its audit event commit or roll back together on the real server', async () => {
    const pool = createDbPool(SMOKE_URL as string);
    try {
      const db: DbClient = createDb(pool);
      await migrateDatabase(db, MIGRATIONS_FOLDER);
      const transact = transactOver(db);
      // a real user row — audit_events.actor_user_id carries a FOREIGN KEY, so the
      // proof uses a genuine account (created through the production UserStore)
      const actorId = randomUUID();
      await bindRepositories(db).users.save({
        userId: actorId,
        username: `audit-tx-${actorId.slice(0, 8)}`,
        passwordHash: 'scrypt$16384$8$1$00$00', // a DB-row fixture, never a credential
        role: 'estimator',
        isActive: true,
        createdAt: INSTANT,
      });
      const actor: Actor = { userId: actorId, username: 'audit-tx-probe' };

      // ROLLBACK: the mutation vanishes WITH its event (real BEGIN … ROLLBACK).
      const rollbackId = randomUUID();
      const rollbackProject = createProject({
        projectId: rollbackId,
        title: 'بازگشت واقعی',
        createdAt: INSTANT,
      });
      await expect(
        transact(async (tx) => {
          await tx.projects.save(rollbackProject);
          await appendAuditEvent(tx.audit, projectCreated(actor, rollbackProject), () => INSTANT);
          throw new Error('forced rollback (real-server S3 proof)');
        }),
      ).rejects.toThrow('forced rollback (real-server S3 proof)');
      const rolledBack = await pool.query(
        'SELECT count(*)::int AS n FROM projects WHERE project_id = $1',
        [rollbackId],
      );
      expect(rolledBack.rows[0]).toEqual({ n: 0 });
      const rolledBackEvents = await pool.query(
        'SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND resource_id = $2',
        ['project.created', rollbackId],
      );
      expect(rolledBackEvents.rows[0]).toEqual({ n: 0 });

      // COMMIT: both rows appear together, exactly once.
      const commitId = randomUUID();
      const commitProject = createProject({
        projectId: commitId,
        title: 'ثبت واقعی',
        createdAt: INSTANT,
      });
      await transact(async (tx) => {
        await tx.projects.save(commitProject);
        await appendAuditEvent(tx.audit, projectCreated(actor, commitProject), () => INSTANT);
      });
      const committed = await pool.query(
        'SELECT count(*)::int AS n FROM projects WHERE project_id = $1',
        [commitId],
      );
      expect(committed.rows[0]).toEqual({ n: 1 });
      const committedEvents = await pool.query(
        'SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND resource_id = $2',
        ['project.created', commitId],
      );
      expect(committedEvents.rows[0]).toEqual({ n: 1 });

      // the repository wiring is the production one (append-only writer, tx-bound)
      expect(
        Object.getOwnPropertyNames(bindRepositories(db).audit.constructor.prototype).sort(),
      ).toEqual(['append', 'constructor']);
    } finally {
      await pool.end();
    }
  });
});
