ALTER TABLE "conversation_members" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "private" boolean DEFAULT false NOT NULL;