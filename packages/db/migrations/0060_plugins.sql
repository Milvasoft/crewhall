CREATE TABLE "plugin_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"package" jsonb NOT NULL,
	"permissions" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"secret_enc" text NOT NULL,
	"installed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_signing_keys" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"kid" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_key_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_signing_keys" ADD CONSTRAINT "plugin_signing_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_installations_plugin_uq" ON "plugin_installations" USING btree ("org_id","plugin_id");