CREATE TABLE "federation_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"node_id" uuid,
	"peer_id" uuid,
	"origin_ref" uuid,
	"name" text NOT NULL,
	"mime" text,
	"size_bytes" bigint NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_reactions" (
	"message_id" uuid NOT NULL,
	"address" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_reactions_message_id_address_emoji_pk" PRIMARY KEY("message_id","address","emoji")
);
--> statement-breakpoint
CREATE TABLE "federation_shared_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"peer_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"host_share_id" uuid NOT NULL,
	"conversation_id" uuid,
	"remote_conversation_id" uuid,
	"channel_name" text NOT NULL,
	"invited_by" text,
	"invited_by_id" uuid,
	"accepted_by_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "federation_keys" ADD COLUMN "instance_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_members" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_peers" ADD COLUMN "remote_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_files" ADD CONSTRAINT "federation_files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_files" ADD CONSTRAINT "federation_files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_files" ADD CONSTRAINT "federation_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_files" ADD CONSTRAINT "federation_files_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_files" ADD CONSTRAINT "federation_files_peer_id_federation_peers_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."federation_peers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reactions" ADD CONSTRAINT "federation_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reactions" ADD CONSTRAINT "federation_reactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_channels" ADD CONSTRAINT "federation_shared_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_channels" ADD CONSTRAINT "federation_shared_channels_peer_id_federation_peers_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."federation_peers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_channels" ADD CONSTRAINT "federation_shared_channels_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_channels" ADD CONSTRAINT "federation_shared_channels_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_channels" ADD CONSTRAINT "federation_shared_channels_accepted_by_id_users_id_fk" FOREIGN KEY ("accepted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_files_message_idx" ON "federation_files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "federation_files_node_idx" ON "federation_files" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_shared_channels_uq" ON "federation_shared_channels" USING btree ("org_id","peer_id","host_share_id");--> statement-breakpoint
CREATE INDEX "federation_shared_channels_conversation_idx" ON "federation_shared_channels" USING btree ("conversation_id");