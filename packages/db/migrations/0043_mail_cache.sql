CREATE TABLE "mail_folder_state" (
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"uid_validity" bigint NOT NULL,
	"uid_next" bigint NOT NULL,
	"modseq" text,
	"complete" boolean DEFAULT false NOT NULL,
	"flags_synced_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_folder_state_account_id_folder_pk" PRIMARY KEY("account_id","folder")
);
--> statement-breakpoint
CREATE TABLE "mail_headers" (
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"uid" bigint NOT NULL,
	"message_id" text,
	"thread_id" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from_name" text,
	"from_address" text,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"date" timestamp with time zone,
	"seen" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "mail_headers_account_id_folder_uid_pk" PRIMARY KEY("account_id","folder","uid")
);
--> statement-breakpoint
ALTER TABLE "mail_folder_state" ADD CONSTRAINT "mail_folder_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_folder_state" ADD CONSTRAINT "mail_folder_state_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_headers" ADD CONSTRAINT "mail_headers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_headers" ADD CONSTRAINT "mail_headers_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_headers_thread_idx" ON "mail_headers" USING btree ("account_id","thread_id");