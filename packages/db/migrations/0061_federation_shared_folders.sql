CREATE TABLE "federation_folder_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"origin_domain" text NOT NULL,
	"origin_id" uuid NOT NULL,
	"node_id" uuid,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"parent_domain" text,
	"parent_origin_id" uuid,
	"local_parent_id" uuid,
	"local_version_id" uuid,
	"version" text,
	"pending_version" text,
	"changed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_shared_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"peer_id" uuid,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"host_folder_id" uuid NOT NULL,
	"root_node_id" uuid,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "federation_shared_channels" ADD COLUMN "meeting_title" text;--> statement-breakpoint
ALTER TABLE "federation_shared_channels" ADD COLUMN "meeting_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_folder_items" ADD CONSTRAINT "federation_folder_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_folder_items" ADD CONSTRAINT "federation_folder_items_folder_id_federation_shared_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."federation_shared_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_folder_items" ADD CONSTRAINT "federation_folder_items_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_folders" ADD CONSTRAINT "federation_shared_folders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_folders" ADD CONSTRAINT "federation_shared_folders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_folders" ADD CONSTRAINT "federation_shared_folders_peer_id_federation_peers_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."federation_peers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_folders" ADD CONSTRAINT "federation_shared_folders_root_node_id_nodes_id_fk" FOREIGN KEY ("root_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_shared_folders" ADD CONSTRAINT "federation_shared_folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_folder_items_origin_uq" ON "federation_folder_items" USING btree ("folder_id","origin_domain","origin_id");--> statement-breakpoint
CREATE INDEX "federation_folder_items_node_idx" ON "federation_folder_items" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_shared_folders_uq" ON "federation_shared_folders" USING btree ("org_id","host_folder_id");--> statement-breakpoint
CREATE INDEX "federation_shared_folders_conversation_idx" ON "federation_shared_folders" USING btree ("conversation_id");