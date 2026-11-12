CREATE TABLE "search_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"chunk" integer DEFAULT 0 NOT NULL,
	"node_id" uuid,
	"space_id" uuid,
	"conversation_id" uuid,
	"seq" bigint,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"source_rev" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(body, '')), 'B')) STORED,
	"embedding" real[],
	"embedding_model" text,
	"source_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "search_chunks" ADD CONSTRAINT "search_chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_chunks_ref_uq" ON "search_chunks" USING btree ("kind","ref_id","chunk");--> statement-breakpoint
CREATE INDEX "search_chunks_org_idx" ON "search_chunks" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "search_chunks_search_gin" ON "search_chunks" USING gin ("search");--> statement-breakpoint
CREATE INDEX "search_chunks_conversation_idx" ON "search_chunks" USING btree ("conversation_id");