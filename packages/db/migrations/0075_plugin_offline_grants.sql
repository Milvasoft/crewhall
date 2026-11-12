CREATE TABLE "plugin_offline_grants" (
	"installation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_offline_grants_installation_id_user_id_pk" PRIMARY KEY("installation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_offline_grants" ADD CONSTRAINT "plugin_offline_grants_installation_id_plugin_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."plugin_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_offline_grants" ADD CONSTRAINT "plugin_offline_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_offline_grants" ADD CONSTRAINT "plugin_offline_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;