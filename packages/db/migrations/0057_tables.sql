CREATE TABLE "data_tables" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"description" text,
	"icon" text,
	"rev" integer DEFAULT 0 NOT NULL,
	"attachment_folder_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_fields" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text,
	"primary" boolean DEFAULT false NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_row_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"author_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_row_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_fields" ADD CONSTRAINT "table_fields_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_fields" ADD CONSTRAINT "table_fields_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_row_comments" ADD CONSTRAINT "table_row_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_row_comments" ADD CONSTRAINT "table_row_comments_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_row_comments" ADD CONSTRAINT "table_row_comments_row_id_table_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."table_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_row_comments" ADD CONSTRAINT "table_row_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_row_history" ADD CONSTRAINT "table_row_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_row_history" ADD CONSTRAINT "table_row_history_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_row_history" ADD CONSTRAINT "table_row_history_row_id_table_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."table_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_row_history" ADD CONSTRAINT "table_row_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_rows" ADD CONSTRAINT "table_rows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_rows" ADD CONSTRAINT "table_rows_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_rows" ADD CONSTRAINT "table_rows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_rows" ADD CONSTRAINT "table_rows_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_views" ADD CONSTRAINT "table_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_views" ADD CONSTRAINT "table_views_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_views" ADD CONSTRAINT "table_views_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_tables_space_idx" ON "data_tables" USING btree ("space_id","updated_at");--> statement-breakpoint
CREATE INDEX "table_fields_table_idx" ON "table_fields" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "table_row_comments_row_idx" ON "table_row_comments" USING btree ("row_id","created_at");--> statement-breakpoint
CREATE INDEX "table_row_history_row_idx" ON "table_row_history" USING btree ("row_id","created_at");--> statement-breakpoint
CREATE INDEX "table_rows_live_idx" ON "table_rows" USING btree ("table_id","position") WHERE "table_rows"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "table_rows_values_gin" ON "table_rows" USING gin ("values");--> statement-breakpoint
CREATE INDEX "table_views_table_idx" ON "table_views" USING btree ("table_id","position");