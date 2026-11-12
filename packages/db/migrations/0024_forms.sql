CREATE TABLE "form_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"response_id" uuid,
	"field_id" text NOT NULL,
	"uploader_key" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"respondent_id" uuid,
	"respondent_key" text,
	"answers" jsonb NOT NULL,
	"channel" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"card_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"title" text COLLATE "tr-x-icu" NOT NULL,
	"description" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"public_token" text NOT NULL,
	"drive_node_id" uuid,
	"owner_id" uuid,
	"last_response_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_files" ADD CONSTRAINT "form_files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_files" ADD CONSTRAINT "form_files_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_files" ADD CONSTRAINT "form_files_response_id_form_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."form_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_respondent_id_users_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_drive_node_id_nodes_id_fk" FOREIGN KEY ("drive_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_files_response_idx" ON "form_files" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX "form_files_orphan_idx" ON "form_files" USING btree ("created_at") WHERE "form_files"."response_id" is null;--> statement-breakpoint
CREATE INDEX "form_responses_form_idx" ON "form_responses" USING btree ("form_id","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_responses_key_uq" ON "form_responses" USING btree ("form_id","respondent_key") WHERE "form_responses"."respondent_key" is not null;--> statement-breakpoint
CREATE INDEX "forms_space_idx" ON "forms" USING btree ("space_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_public_token_uq" ON "forms" USING btree ("public_token");