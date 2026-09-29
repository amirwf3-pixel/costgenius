-- P8-A S4 (CG-GOV-SPEC@0.1.0 §5/§7): reviewer sign-off representation — NO new table.
-- The three nullable columns on the two finalized tables: `finalized_by` (the actor
-- stamped at finalization; NULL on rows finalized before V1.1 — legacy, §5), and
-- `approved_by`/`approved_at` (NULL = not approved; both set = APPROVED/LOCKED,
-- irreversible in this phase). Existing rows keep NULL. Migrations 0000–0002 and
-- the 12-table shape are untouched; the append-only REVOKE on audit_events is not
-- affected (UPDATE/DELETE there stay revoked for the application role).
ALTER TABLE "finalized_estimates" ADD COLUMN "finalized_by" uuid;--> statement-breakpoint
ALTER TABLE "finalized_estimates" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "finalized_estimates" ADD COLUMN "approved_at" text;--> statement-breakpoint
ALTER TABLE "finalized_takeoffs" ADD COLUMN "finalized_by" uuid;--> statement-breakpoint
ALTER TABLE "finalized_takeoffs" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "finalized_takeoffs" ADD COLUMN "approved_at" text;--> statement-breakpoint
ALTER TABLE "finalized_estimates" ADD CONSTRAINT "finalized_estimates_finalized_by_users_user_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finalized_estimates" ADD CONSTRAINT "finalized_estimates_approved_by_users_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finalized_takeoffs" ADD CONSTRAINT "finalized_takeoffs_finalized_by_users_user_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finalized_takeoffs" ADD CONSTRAINT "finalized_takeoffs_approved_by_users_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;