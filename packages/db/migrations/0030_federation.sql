CREATE TABLE "federation_conversations" (
	"conversation_id" uuid NOT NULL,
	"peer_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"remote_conversation_id" uuid,
	"home_domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_conversations_conversation_id_peer_id_pk" PRIMARY KEY("conversation_id","peer_id")
);
--> statement-breakpoint
CREATE TABLE "federation_handles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_inbox" (
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"activity_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_inbox_org_id_domain_activity_id_pk" PRIMARY KEY("org_id","domain","activity_id")
);
--> statement-breakpoint
CREATE TABLE "federation_keys" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_members" (
	"conversation_id" uuid NOT NULL,
	"remote_user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_members_conversation_id_remote_user_id_pk" PRIMARY KEY("conversation_id","remote_user_id")
);
--> statement-breakpoint
CREATE TABLE "federation_peers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"name" text,
	"public_key" text,
	"we_added" boolean DEFAULT false NOT NULL,
	"they_added" boolean DEFAULT false NOT NULL,
	"added_by" uuid,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"peer_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "federation_conversations" ADD CONSTRAINT "federation_conversations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_conversations" ADD CONSTRAINT "federation_conversations_peer_id_federation_peers_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."federation_peers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_conversations" ADD CONSTRAINT "federation_conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_handles" ADD CONSTRAINT "federation_handles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_handles" ADD CONSTRAINT "federation_handles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_inbox" ADD CONSTRAINT "federation_inbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_keys" ADD CONSTRAINT "federation_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_members" ADD CONSTRAINT "federation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_members" ADD CONSTRAINT "federation_members_remote_user_id_federation_users_id_fk" FOREIGN KEY ("remote_user_id") REFERENCES "public"."federation_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_members" ADD CONSTRAINT "federation_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_members" ADD CONSTRAINT "federation_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_peers" ADD CONSTRAINT "federation_peers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_peers" ADD CONSTRAINT "federation_peers_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_users" ADD CONSTRAINT "federation_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_users" ADD CONSTRAINT "federation_users_peer_id_federation_peers_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."federation_peers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_conversations_remote_idx" ON "federation_conversations" USING btree ("peer_id","remote_conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_handles_handle_uq" ON "federation_handles" USING btree ("org_id","handle");--> statement-breakpoint
CREATE INDEX "federation_inbox_received_idx" ON "federation_inbox" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_peers_domain_uq" ON "federation_peers" USING btree ("org_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_users_handle_uq" ON "federation_users" USING btree ("peer_id","handle");