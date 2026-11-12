CREATE TYPE "public"."vault_item_type" AS ENUM('login', 'note', 'card', 'api_key', 'ssh_key', 'identity');--> statement-breakpoint
CREATE TYPE "public"."vault_kind" AS ENUM('personal', 'space');--> statement-breakpoint
CREATE TYPE "public"."vault_role" AS ENUM('read', 'edit', 'manage');--> statement-breakpoint
CREATE TYPE "public"."vault_unlock_kind" AS ENUM('passkey_prf', 'device');--> statement-breakpoint
CREATE TABLE "user_key_unlocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"method" "vault_unlock_kind" NOT NULL,
	"label" text NOT NULL,
	"credential_id" text,
	"prf_salt" "bytea",
	"wrapped_private_key" "bytea" NOT NULL,
	"verifier_hash" "bytea" NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"public_key" "bytea" NOT NULL,
	"fingerprint" text NOT NULL,
	"encrypted_private_key" "bytea" NOT NULL,
	"kdf" jsonb NOT NULL,
	"password_verifier_hash" "bytea" NOT NULL,
	"recovery_wrapped_key" "bytea" NOT NULL,
	"recovery_verifier_hash" "bytea" NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"settings" "bytea",
	"recovery_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"vault_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"space_id" uuid,
	"size" bigint NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"s3_upload_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vault_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"vault_id" uuid,
	"item_id" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"field" text,
	"target_user_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_item_revisions" (
	"item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"vault_id" uuid NOT NULL,
	"type" "vault_item_type" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"item_key_wrapped" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vault_item_revisions_item_id_revision_pk" PRIMARY KEY("item_id","revision")
);
--> statement-breakpoint
CREATE TABLE "vault_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"vault_id" uuid NOT NULL,
	"type" "vault_item_type" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"item_key_wrapped" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_members" (
	"vault_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role" "vault_role" NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_members_vault_id_user_id_pk" PRIMARY KEY("vault_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "vault_vaults" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "vault_kind" NOT NULL,
	"space_id" uuid,
	"owner_user_id" uuid,
	"name" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_key_unlocks" ADD CONSTRAINT "user_key_unlocks_user_id_user_keys_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_keys"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_attachments" ADD CONSTRAINT "vault_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_attachments" ADD CONSTRAINT "vault_attachments_vault_id_vault_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_attachments" ADD CONSTRAINT "vault_attachments_item_id_vault_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vault_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_attachments" ADD CONSTRAINT "vault_attachments_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_attachments" ADD CONSTRAINT "vault_attachments_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_attachments" ADD CONSTRAINT "vault_attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_events" ADD CONSTRAINT "vault_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_events" ADD CONSTRAINT "vault_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_events" ADD CONSTRAINT "vault_events_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_item_revisions" ADD CONSTRAINT "vault_item_revisions_item_id_vault_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vault_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_item_revisions" ADD CONSTRAINT "vault_item_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_item_revisions" ADD CONSTRAINT "vault_item_revisions_vault_id_vault_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_item_revisions" ADD CONSTRAINT "vault_item_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_vault_id_vault_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_members" ADD CONSTRAINT "vault_members_vault_id_vault_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_members" ADD CONSTRAINT "vault_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_members" ADD CONSTRAINT "vault_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_members" ADD CONSTRAINT "vault_members_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_vaults" ADD CONSTRAINT "vault_vaults_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_vaults" ADD CONSTRAINT "vault_vaults_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_vaults" ADD CONSTRAINT "vault_vaults_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_vaults" ADD CONSTRAINT "vault_vaults_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_key_unlocks_user_idx" ON "user_key_unlocks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vault_attachments_item_idx" ON "vault_attachments" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "vault_events_vault_at_idx" ON "vault_events" USING btree ("vault_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "vault_events_actor_at_idx" ON "vault_events" USING btree ("actor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "vault_events_org_at_idx" ON "vault_events" USING btree ("org_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "vault_items_vault_idx" ON "vault_items" USING btree ("vault_id","id");--> statement-breakpoint
CREATE INDEX "vault_items_deleted_idx" ON "vault_items" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "vault_members_user_idx" ON "vault_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_vaults_personal_uq" ON "vault_vaults" USING btree ("org_id","owner_user_id") WHERE "vault_vaults"."kind" = 'personal';--> statement-breakpoint
CREATE INDEX "vault_vaults_space_idx" ON "vault_vaults" USING btree ("space_id");