CREATE TABLE "mail_bulk_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer,
	"done" integer DEFAULT 0 NOT NULL,
	"error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_bulk_jobs" ADD CONSTRAINT "mail_bulk_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_bulk_jobs" ADD CONSTRAINT "mail_bulk_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_bulk_jobs" ADD CONSTRAINT "mail_bulk_jobs_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_bulk_jobs_account_idx" ON "mail_bulk_jobs" USING btree ("account_id","status");