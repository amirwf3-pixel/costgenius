CREATE TABLE "finalized_takeoffs" (
	"document_id" text PRIMARY KEY NOT NULL,
	"takeoff_id" text NOT NULL,
	"document_number" integer NOT NULL,
	"finalized_at" text NOT NULL,
	"spec_version" text NOT NULL,
	"engine_version" text NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "takeoff_documents" (
	"document_id" text PRIMARY KEY NOT NULL,
	"takeoff_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"document_number" integer NOT NULL,
	"status" text NOT NULL,
	"revision" integer NOT NULL,
	"rounding_rule_set" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"archived_at" text,
	"finalized_at" text,
	CONSTRAINT "takeoff_documents_status_check" CHECK ("takeoff_documents"."status" in ('draft', 'archived', 'finalized')),
	CONSTRAINT "takeoff_documents_revision_check" CHECK ("takeoff_documents"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "takeoff_lines" (
	"document_id" text NOT NULL,
	"line_id" text NOT NULL,
	"sheet_id" text NOT NULL,
	"row_no" integer NOT NULL,
	"description" text NOT NULL,
	"location" text,
	"item_code" text,
	"kind" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" jsonb NOT NULL,
	"notes" text,
	"origin" text,
	"rule_refs" jsonb,
	CONSTRAINT "takeoff_lines_document_id_line_id_pk" PRIMARY KEY("document_id","line_id")
);
--> statement-breakpoint
CREATE TABLE "takeoff_sheets" (
	"document_id" text NOT NULL,
	"sheet_id" text NOT NULL,
	"name" text NOT NULL,
	"sheet_order" integer NOT NULL,
	CONSTRAINT "takeoff_sheets_document_id_sheet_id_pk" PRIMARY KEY("document_id","sheet_id")
);
--> statement-breakpoint
ALTER TABLE "finalized_takeoffs" ADD CONSTRAINT "finalized_takeoffs_document_id_takeoff_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."takeoff_documents"("document_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeoff_documents" ADD CONSTRAINT "takeoff_documents_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeoff_lines" ADD CONSTRAINT "takeoff_lines_sheet_fk" FOREIGN KEY ("document_id","sheet_id") REFERENCES "public"."takeoff_sheets"("document_id","sheet_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeoff_sheets" ADD CONSTRAINT "takeoff_sheets_document_id_takeoff_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."takeoff_documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "takeoff_documents_chain_number_key" ON "takeoff_documents" USING btree ("takeoff_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "takeoff_lines_sheet_row_key" ON "takeoff_lines" USING btree ("document_id","sheet_id","row_no");--> statement-breakpoint
CREATE UNIQUE INDEX "takeoff_sheets_document_order_key" ON "takeoff_sheets" USING btree ("document_id","sheet_order");