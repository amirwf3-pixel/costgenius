CREATE TABLE "pricebook_editions" (
	"edition_id" text PRIMARY KEY NOT NULL,
	"discipline" text NOT NULL,
	"year" text NOT NULL,
	"title" text NOT NULL,
	"organization" text NOT NULL,
	"notification_number" text,
	"notification_date" text,
	"source_file_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"content" jsonb NOT NULL,
	"import_report" jsonb NOT NULL,
	"status" text NOT NULL,
	"supersedes_edition_id" text,
	"imported_by" uuid NOT NULL,
	"imported_at" text NOT NULL,
	"activated_by" uuid,
	"activated_at" text,
	"archived_by" uuid,
	"archived_at" text,
	CONSTRAINT "pricebook_editions_content_hash_key" UNIQUE("content_hash"),
	CONSTRAINT "pricebook_editions_discipline_check" CHECK ("pricebook_editions"."discipline" = 'abniye'),
	CONSTRAINT "pricebook_editions_status_check" CHECK ("pricebook_editions"."status" in ('DRAFT', 'ACTIVE', 'ARCHIVED'))
);
--> statement-breakpoint
ALTER TABLE "estimate_versions" ADD COLUMN "edition_id" text;--> statement-breakpoint
ALTER TABLE "pricebook_editions" ADD CONSTRAINT "pricebook_editions_supersedes_edition_id_pricebook_editions_edition_id_fk" FOREIGN KEY ("supersedes_edition_id") REFERENCES "public"."pricebook_editions"("edition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_editions" ADD CONSTRAINT "pricebook_editions_imported_by_users_user_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_editions" ADD CONSTRAINT "pricebook_editions_activated_by_users_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_editions" ADD CONSTRAINT "pricebook_editions_archived_by_users_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pricebook_editions_one_active" ON "pricebook_editions" USING btree ("discipline") WHERE "pricebook_editions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "pricebook_editions_status_idx" ON "pricebook_editions" USING btree ("status");--> statement-breakpoint
ALTER TABLE "estimate_versions" ADD CONSTRAINT "estimate_versions_edition_id_pricebook_editions_edition_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."pricebook_editions"("edition_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- P8-B S1 (CG-IR-PRICEBOOK-SPEC@0.2.0 §11/§12) — database-level immutability, independent
-- of any role: PostgreSQL table OWNERSHIP bypasses GRANT/REVOKE, and the documented
-- default deployment runs the API as the migrating owner (DEPLOYMENT.md), so
-- column-limited grants alone cannot satisfy the §11 requirement. These trigger guards
-- are the contract's sanctioned equivalent mechanism: they hold for EVERY role,
-- including the owner. Only the lifecycle columns (status, activated_by/at,
-- archived_by/at) may ever change; content, provenance and import identity are frozen
-- at import; rows are never deleted (editions are referenced forever, §8).
CREATE FUNCTION "pricebook_editions_guard_immutable_columns"() RETURNS trigger AS $pb_edition_guard$
BEGIN
  IF NEW."edition_id" IS DISTINCT FROM OLD."edition_id"
     OR NEW."discipline" IS DISTINCT FROM OLD."discipline"
     OR NEW."year" IS DISTINCT FROM OLD."year"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."organization" IS DISTINCT FROM OLD."organization"
     OR NEW."notification_number" IS DISTINCT FROM OLD."notification_number"
     OR NEW."notification_date" IS DISTINCT FROM OLD."notification_date"
     OR NEW."source_file_hash" IS DISTINCT FROM OLD."source_file_hash"
     OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
     OR NEW."content" IS DISTINCT FROM OLD."content"
     OR NEW."import_report" IS DISTINCT FROM OLD."import_report"
     OR NEW."supersedes_edition_id" IS DISTINCT FROM OLD."supersedes_edition_id"
     OR NEW."imported_by" IS DISTINCT FROM OLD."imported_by"
     OR NEW."imported_at" IS DISTINCT FROM OLD."imported_at"
  THEN
    RAISE EXCEPTION 'pricebook_editions "%" is immutable: only the lifecycle columns (status, activated_by/at, archived_by/at) may change; any content or provenance change is a NEW edition (P8-B 0.2.0 section 11)', OLD."edition_id";
  END IF;
  RETURN NEW;
END;
$pb_edition_guard$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "pricebook_editions_immutable_columns_guard"
  BEFORE UPDATE ON "pricebook_editions"
  FOR EACH ROW EXECUTE FUNCTION "pricebook_editions_guard_immutable_columns"();--> statement-breakpoint
CREATE FUNCTION "pricebook_editions_forbid_delete"() RETURNS trigger AS $pb_edition_guard$
BEGIN
  RAISE EXCEPTION 'pricebook_editions "%" is never deleted: editions are append-only and referenced forever by estimate versions (P8-B 0.2.0 section 8/11)', OLD."edition_id";
END;
$pb_edition_guard$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "pricebook_editions_delete_forbidden"
  BEFORE DELETE ON "pricebook_editions"
  FOR EACH ROW EXECUTE FUNCTION "pricebook_editions_forbid_delete"();--> statement-breakpoint
-- The edition binding of an estimate version is immutable once set (P8-B 0.2.0
-- section 12): establishing it (NULL -> value, the S1 backfill) is the only write
-- ever permitted to this column — a set binding is never changed or cleared.
CREATE FUNCTION "estimate_versions_guard_edition_binding"() RETURNS trigger AS $pb_binding_guard$
BEGIN
  IF OLD."edition_id" IS NOT NULL AND NEW."edition_id" IS DISTINCT FROM OLD."edition_id" THEN
    RAISE EXCEPTION 'estimate_versions "%" edition binding is immutable once set (P8-B 0.2.0 section 12)', OLD."version_id";
  END IF;
  RETURN NEW;
END;
$pb_binding_guard$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "estimate_versions_edition_binding_guard"
  BEFORE UPDATE ON "estimate_versions"
  FOR EACH ROW EXECUTE FUNCTION "estimate_versions_guard_edition_binding"();--> statement-breakpoint
-- New estimate versions are bound to the ACTIVE edition at insert (D-PB-3 = B,
-- resolution rule A: an omitted edition means the current ACTIVE edition; the S3
-- explicit selection supplies the column and skips the stamp). With no ACTIVE edition
-- the binding stays NULL — the API layer owns the deterministic EDITION_NOT_ACTIVE
-- failure; nothing is ever guessed here.
CREATE FUNCTION "estimate_versions_stamp_active_edition"() RETURNS trigger AS $pb_binding_stamp$
BEGIN
  IF NEW."edition_id" IS NULL THEN
    SELECT "edition_id" INTO NEW."edition_id"
    FROM "pricebook_editions" WHERE "status" = 'ACTIVE' ORDER BY "edition_id" LIMIT 1;
  END IF;
  RETURN NEW;
END;
$pb_binding_stamp$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "estimate_versions_bind_active_edition"
  BEFORE INSERT ON "estimate_versions"
  FOR EACH ROW EXECUTE FUNCTION "estimate_versions_stamp_active_edition"();--> statement-breakpoint
-- The defense-in-depth posture of migration 0002 (audit_events), extended to editions:
-- non-owner roles get nothing by default. The application-role column-limited grants
-- (SELECT + INSERT + UPDATE of the lifecycle columns only) are the DEPLOYMENT.md
-- runbook; the trigger guards above are what enforces immutability for the owner too.
REVOKE UPDATE, DELETE ON TABLE "pricebook_editions" FROM PUBLIC;
