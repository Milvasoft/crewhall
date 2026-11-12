CREATE TABLE "plugin_linked_users" (
	"installation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_linked_users_installation_id_user_id_pk" PRIMARY KEY("installation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_notification_prefs" (
	"installation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_notification_prefs_installation_id_user_id_pk" PRIMARY KEY("installation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_linked_users" ADD CONSTRAINT "plugin_linked_users_installation_id_plugin_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."plugin_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_linked_users" ADD CONSTRAINT "plugin_linked_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_linked_users" ADD CONSTRAINT "plugin_linked_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_notification_prefs" ADD CONSTRAINT "plugin_notification_prefs_installation_id_plugin_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."plugin_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_notification_prefs" ADD CONSTRAINT "plugin_notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_notification_prefs" ADD CONSTRAINT "plugin_notification_prefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;