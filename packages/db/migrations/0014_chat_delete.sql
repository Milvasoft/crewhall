ALTER TABLE "conversation_members" ADD COLUMN "cleared_at_seq" bigint;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "archived_at" timestamp with time zone;