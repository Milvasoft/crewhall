CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"space_id" uuid,
	"owner_user_id" uuid,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'team' NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_org_kind_idx" ON "templates" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "templates_space_idx" ON "templates" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "templates_owner_idx" ON "templates" USING btree ("owner_user_id");--> statement-breakpoint
-- Saved page templates move to the shared gallery table (roadmap 8): kind "page", content {markdown}.
INSERT INTO "templates" ("id", "org_id", "kind", "scope", "space_id", "owner_user_id", "name", "description", "category", "content", "created_by", "created_at", "updated_at")
SELECT "id", "org_id", 'page', CASE WHEN "space_id" IS NOT NULL THEN 'space' ELSE 'personal' END, "space_id", "owner_user_id", "name", "description", "category", jsonb_build_object('markdown', "markdown"), "created_by", "created_at", "updated_at"
FROM "page_templates";
