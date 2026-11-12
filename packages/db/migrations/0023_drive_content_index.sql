CREATE TABLE "blob_contents" (
	"blob_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text NOT NULL,
	"kind" text,
	"content" text DEFAULT '' NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"chars" integer DEFAULT 0 NOT NULL,
	"error" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('turkish'::regconfig, "content") || to_tsvector('english'::regconfig, "content")) STORED,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blob_contents" ADD CONSTRAINT "blob_contents_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_contents" ADD CONSTRAINT "blob_contents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_contents_search_gin" ON "blob_contents" USING gin ("search");--> statement-breakpoint
CREATE INDEX "blob_contents_org_idx" ON "blob_contents" USING btree ("org_id");