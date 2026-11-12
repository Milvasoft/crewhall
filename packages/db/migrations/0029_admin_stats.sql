CREATE TABLE "activity_daily" (
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"area" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "activity_daily_org_id_day_user_id_area_pk" PRIMARY KEY("org_id","day","user_id","area")
);
--> statement-breakpoint
CREATE TABLE "org_stats_daily" (
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"dim" text DEFAULT '' NOT NULL,
	"value" bigint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_stats_daily_org_id_day_metric_dim_pk" PRIMARY KEY("org_id","day","metric","dim")
);
--> statement-breakpoint
ALTER TABLE "activity_daily" ADD CONSTRAINT "activity_daily_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_daily" ADD CONSTRAINT "activity_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_stats_daily" ADD CONSTRAINT "org_stats_daily_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_daily_day_idx" ON "activity_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "org_stats_daily_metric_idx" ON "org_stats_daily" USING btree ("org_id","metric","day");