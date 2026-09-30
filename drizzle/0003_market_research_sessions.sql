CREATE TABLE "market_research_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "part_id" integer NOT NULL,
  "researched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source" text DEFAULT 'ebay_product_research_manual' NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "research_session_id" integer;
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "sold_price_min" numeric(10, 2);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "sold_price_max" numeric(10, 2);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "total_sellers" integer;
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "sell_through_pct" numeric(8, 2);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "free_shipping_pct" numeric(5, 2);
--> statement-breakpoint
ALTER TABLE "market_research_sessions" ADD CONSTRAINT "market_research_sessions_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_research_session_id_market_research_sessions_id_fk" FOREIGN KEY ("research_session_id") REFERENCES "public"."market_research_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_sold_price_min_sane" CHECK ("market_snapshots"."sold_price_min" IS NULL OR ("market_snapshots"."sold_price_min" >= 0 AND "market_snapshots"."sold_price_min" <= 1000000));
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_sold_price_max_sane" CHECK ("market_snapshots"."sold_price_max" IS NULL OR ("market_snapshots"."sold_price_max" >= 0 AND "market_snapshots"."sold_price_max" <= 1000000));
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_sold_price_range_sane" CHECK ("market_snapshots"."sold_price_min" IS NULL OR "market_snapshots"."sold_price_max" IS NULL OR "market_snapshots"."sold_price_min" <= "market_snapshots"."sold_price_max");
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_total_sellers_nonneg" CHECK ("market_snapshots"."total_sellers" IS NULL OR "market_snapshots"."total_sellers" >= 0);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_sell_through_nonneg" CHECK ("market_snapshots"."sell_through_pct" IS NULL OR "market_snapshots"."sell_through_pct" >= 0);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_free_shipping_pct_sane" CHECK ("market_snapshots"."free_shipping_pct" IS NULL OR ("market_snapshots"."free_shipping_pct" >= 0 AND "market_snapshots"."free_shipping_pct" <= 100));
--> statement-breakpoint
CREATE INDEX "research_sessions_part_researched_idx" ON "market_research_sessions" USING btree ("part_id","researched_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "research_sessions_researched_idx" ON "market_research_sessions" USING btree ("researched_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "snapshots_research_session_period_idx" ON "market_snapshots" USING btree ("research_session_id","period");
--> statement-breakpoint
CREATE INDEX "parts_description_idx" ON "parts" USING btree ("description");
--> statement-breakpoint
CREATE INDEX "parts_category_idx" ON "parts" USING btree ("category");
