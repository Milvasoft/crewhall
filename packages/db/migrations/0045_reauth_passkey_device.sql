CREATE TABLE "device_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reauth_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"challenge" text NOT NULL,
	"device_key_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reauth_challenges" ADD CONSTRAINT "reauth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reauth_challenges" ADD CONSTRAINT "reauth_challenges_device_key_id_device_keys_id_fk" FOREIGN KEY ("device_key_id") REFERENCES "public"."device_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_keys_user_idx" ON "device_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reauth_challenges_user_idx" ON "reauth_challenges" USING btree ("user_id");