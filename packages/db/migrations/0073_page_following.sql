ALTER TABLE "node_user_state" ADD COLUMN "following" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "node_user_state" ADD COLUMN "follow_notified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "node_user_state_following_idx" ON "node_user_state" USING btree ("node_id") WHERE "node_user_state"."following";