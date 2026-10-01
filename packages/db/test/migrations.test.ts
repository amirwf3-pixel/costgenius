import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

const MIGRATIONS_FOLDER = new URL('../migrations', import.meta.url).pathname;

describe('migrations', () => {
  it('apply cleanly to a fresh PostgreSQL (PGlite) instance and create the full schema', async () => {
    const pg = new PGlite();
    await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS_FOLDER });
    const tables = await pg.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    // P8-B S1 (migration 0004_p8b_pricebook_editions): the edition registry joins the
    // twelve Phase-14/D-016/governance tables — thirteen in total.
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      'audit_events',
      'boq_lines',
      'estimate_versions',
      'estimates',
      'finalized_estimates',
      'finalized_takeoffs',
      'pricebook_editions',
      'projects',
      'sessions',
      'takeoff_documents',
      'takeoff_lines',
      'takeoff_sheets',
      'users',
    ]);
    // Drizzle's journal table lives in its own schema (never mixed with business tables)
    const journal = await pg.query<{ schemaname: string; tablename: string }>(
      "select schemaname, tablename from pg_tables where tablename = '__drizzle_migrations'",
    );
    expect(journal.rows).toEqual([{ schemaname: 'drizzle', tablename: '__drizzle_migrations' }]);

    // the schema is exact where exactness matters
    const columns = await pg.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      'select table_name, column_name, data_type, is_nullable from information_schema.columns ' +
        "where table_name in ('boq_lines') and column_name in ('quantity', 'base_price', 'line_amount', 'pricebook_code') " +
        'order by column_name',
    );
    const byColumn = new Map(columns.rows.map((r) => [r.column_name, r]));
    expect(byColumn.get('quantity')?.data_type).toBe('numeric'); // exact decimals, never float
    expect(byColumn.get('base_price')?.data_type).toBe('numeric');
    expect(byColumn.get('line_amount')?.data_type).toBe('numeric');
    expect(byColumn.get('base_price')?.is_nullable).toBe('YES'); // blank ≠ zero
    expect(byColumn.get('pricebook_code')?.data_type).toBe('text'); // leading zeros
  });

  it('are idempotent (journal-based re-run is a no-op)', async () => {
    const pg = new PGlite();
    const db = drizzle(pg);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const applied = await pg.query<{ count: string }>(
      'select count(*)::text as count from drizzle.__drizzle_migrations',
    );
    const shipped = readdirSync(new URL('../migrations', import.meta.url).pathname)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(applied.rows[0]?.count).toBe(String(shipped.length));
  });

  it('contain no seed data and no secrets (pure DDL)', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const files = readdirSync(new URL('../migrations', import.meta.url)).filter((f) =>
      f.endsWith('.sql'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      // every statement is pure DDL (FK clauses legitimately contain "ON UPDATE no action")
      const statements = sql
        .split('--> statement-breakpoint')
        .map((stmt) => stmt.trim())
        .filter((stmt) => stmt.length > 0);
      expect(statements.length).toBeGreaterThan(0);
      for (const stmt of statements) {
        // comment lines are documentation, not statements — strip before matching
        const codeOnly = stmt.replace(/^--.*$/gm, '').trim();
        // P8-A S1: REVOKE (access-control DDL, CG-GOV §4.2/§7 — the append-only
        // defense of audit_events) is a documented non-CREATE statement form.
        // P8-B S1: CREATE FUNCTION / CREATE TRIGGER (migration 0004) are the
        // database-level immutability + binding guards of CG-IR-PRICEBOOK-SPEC@0.2.0
        // §11/§12 — pure DDL, no data, enforced for every role including the owner.
        expect(codeOnly).toMatch(
          /^(CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX|REVOKE UPDATE, DELETE|CREATE (OR REPLACE )?FUNCTION|CREATE TRIGGER)/,
        );
      }
      expect(sql).not.toMatch(/\bINSERT\s+INTO\b|\bCREATE\s+ROLE\b|\bCREATE\s+USER\b/i); // no data, no users
      // no secrets — the two inspected governance IDENTIFIERS (column names, never
      // values) are stripped first so the scan stays strict for everything else
      const identifierNamesOnly = sql
        .replaceAll('password_hash', '')
        .replaceAll('session_token_hash', '');
      expect(identifierNamesOnly).not.toMatch(/password|secret|token|api[_-]?key|DATABASE_URL/i); // no secrets
      // no 1404 pricebook data is ever seeded through a migration
      expect(sql).not.toContain('010101');
      expect(sql).not.toContain('270320');
    }
  });
});
