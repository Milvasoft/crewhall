CREATE TABLE "contact_companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"kind" text DEFAULT 'customer' NOT NULL,
	"domain" "citext",
	"website" text,
	"email" "citext",
	"phone" text,
	"address" text,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"dav_name" text,
	"kind" text DEFAULT 'customer' NOT NULL,
	"first_name" text,
	"last_name" text,
	"display_name" text COLLATE "tr-x-icu" NOT NULL,
	"company_id" uuid,
	"job_title" text,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"address" text,
	"website" text,
	"birthday" text,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_profiles" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"department" text COLLATE "tr-x-icu",
	"team" text COLLATE "tr-x-icu",
	"phone" text,
	"mobile" text,
	"location" text COLLATE "tr-x-icu",
	"about" text,
	"manager_id" uuid,
	"synced_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_profiles_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_contact_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."contact_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD CONSTRAINT "directory_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD CONSTRAINT "directory_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD CONSTRAINT "directory_profiles_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_companies_org_idx" ON "contact_companies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contact_companies_name_trgm_idx" ON "contact_companies" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_org_idx" ON "contacts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_uid_uq" ON "contacts" USING btree ("org_id","uid") WHERE "contacts"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_dav_name_uq" ON "contacts" USING btree ("org_id","dav_name") WHERE "contacts"."dav_name" is not null and "contacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_search_trgm_idx" ON "contacts" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "directory_profiles_manager_idx" ON "directory_profiles" USING btree ("org_id","manager_id");