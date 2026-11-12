CREATE TABLE "dav_locks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"depth" text NOT NULL,
	"owner" text,
	"timeout_seconds" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dav_locks" ADD CONSTRAINT "dav_locks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dav_locks" ADD CONSTRAINT "dav_locks_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dav_locks" ADD CONSTRAINT "dav_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dav_locks_node_idx" ON "dav_locks" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "dav_locks_expires_idx" ON "dav_locks" USING btree ("expires_at");