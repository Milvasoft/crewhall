CREATE TABLE "user_ui_prefs" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ui_prefs_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_ui_prefs" ADD CONSTRAINT "user_ui_prefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ui_prefs" ADD CONSTRAINT "user_ui_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;