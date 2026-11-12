CREATE TYPE "public"."page_export_format" AS ENUM('md', 'html', 'docx', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."page_export_status" AS ENUM('queued', 'running', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "page_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"format" "page_export_format" NOT NULL,
	"children" boolean DEFAULT false NOT NULL,
	"status" "page_export_status" DEFAULT 'queued' NOT NULL,
	"file_name" text,
	"storage_key" text,
	"size_bytes" integer,
	"page_count" integer,
	"skipped" text[] DEFAULT '{}'::text[] NOT NULL,
	"error" text,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_exports" ADD CONSTRAINT "page_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_exports" ADD CONSTRAINT "page_exports_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_exports" ADD CONSTRAINT "page_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_exports_user_idx" ON "page_exports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "page_exports_expires_idx" ON "page_exports" USING btree ("expires_at");