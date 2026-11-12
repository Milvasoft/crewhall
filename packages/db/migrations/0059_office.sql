CREATE TABLE "office_doc_keys" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"doc_key" text NOT NULL,
	"base_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "office_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"server_type" text DEFAULT 'onlyoffice' NOT NULL,
	"server_url" text,
	"internal_url" text,
	"jwt_secret_enc" text,
	"jwt_secret_hint" text,
	"last_test" jsonb,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wopi_locks" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"lock" text NOT NULL,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "office_doc_keys" ADD CONSTRAINT "office_doc_keys_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_doc_keys" ADD CONSTRAINT "office_doc_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_settings" ADD CONSTRAINT "office_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_settings" ADD CONSTRAINT "office_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wopi_locks" ADD CONSTRAINT "wopi_locks_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wopi_locks" ADD CONSTRAINT "wopi_locks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wopi_locks" ADD CONSTRAINT "wopi_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wopi_locks_org_idx" ON "wopi_locks" USING btree ("org_id");