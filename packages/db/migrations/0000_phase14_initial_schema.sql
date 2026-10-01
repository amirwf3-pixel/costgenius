CREATE TABLE "boq_lines" (
	"version_id" text NOT NULL,
	"line_index" integer NOT NULL,
	"line_id" text NOT NULL,
	"pricebook_code" text NOT NULL,
	"chapter" text NOT NULL,
	"group_number" text NOT NULL,
	"description" text NOT NULL,
	"unit_label" text NOT NULL,
	"unit_code" text NOT NULL,
	"quantity" numeric NOT NULL,
	"base_price" numeric,
	"line_amount" numeric,
	"pricebook_status" text NOT NULL,
	"calculation_status" text NOT NULL,
	"source_ref" jsonb NOT NULL,
	"edition" text NOT NULL,
	"external_dependencies" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"trace" jsonb NOT NULL,
	"building_id" text,
	"landscaping" boolean,
	CONSTRAINT "boq_lines_version_id_line_id_pk" PRIMARY KEY("version_id","line_id")
);
--> statement-breakpoint
CREATE TABLE "estimate_versions" (
	"version_id" text PRIMARY KEY NOT NULL,
	"estimate_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"edition" text NOT NULL,
	"building_id" text,
	"metadata" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"estimate_id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finalized_estimates" (
	"version_id" text PRIMARY KEY NOT NULL,
	"estimate_id" text NOT NULL,
	"finalized_at" text NOT NULL,
	"s4_input" jsonb NOT NULL,
	"s4_result" jsonb NOT NULL,
	"rollup" jsonb NOT NULL,
	"report_model" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"title" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boq_lines" ADD CONSTRAINT "boq_lines_version_id_estimate_versions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."estimate_versions"("version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_versions" ADD CONSTRAINT "estimate_versions_estimate_id_estimates_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("estimate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finalized_estimates" ADD CONSTRAINT "finalized_estimates_version_id_estimate_versions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."estimate_versions"("version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finalized_estimates" ADD CONSTRAINT "finalized_estimates_estimate_id_estimates_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("estimate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "estimate_versions_estimate_number_key" ON "estimate_versions" USING btree ("estimate_id","version_number");