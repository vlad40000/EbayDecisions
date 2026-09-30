CREATE TYPE "public"."price_basis" AS ENUM('unknown', 'sold', 'asking');--> statement-breakpoint
ALTER TABLE "market_snapshots" RENAME COLUMN "qty" TO "legacy_qty";--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "sold_qty" integer;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "price_basis" "price_basis" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
UPDATE "market_snapshots"
SET "price_basis" = CASE
  WHEN "source" = 'ebay_insights' THEN 'sold'::"price_basis"
  WHEN "source" = 'ebay_browse' THEN 'asking'::"price_basis"
  ELSE 'unknown'::"price_basis"
END;--> statement-breakpoint
UPDATE "market_snapshots"
SET "sold_qty" = "legacy_qty"
WHERE "source" = 'ebay_insights';--> statement-breakpoint
CREATE TABLE "active_market_snapshots" (
  "id" serial PRIMARY KEY NOT NULL,
  "part_id" integer NOT NULL,
  "asking_price" numeric(10, 2),
  "asking_shipping" numeric(10, 2),
  "active_qty" integer,
  "source" "snapshot_source" DEFAULT 'manual' NOT NULL,
  "sample_size" integer,
  "broad_match_count" integer,
  "mpn_rejected_count" integer,
  "condition_rejected_count" integer,
  "truncated" boolean DEFAULT false NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "active_market_snapshots" ADD CONSTRAINT "active_market_snapshots_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "active_snapshots_part_captured_idx" ON "active_market_snapshots" USING btree ("part_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "active_market_snapshots" ADD CONSTRAINT "active_snapshots_price_sane" CHECK ("active_market_snapshots"."asking_price" IS NULL OR ("active_market_snapshots"."asking_price" >= 0 AND "active_market_snapshots"."asking_price" <= 1000000));--> statement-breakpoint
ALTER TABLE "active_market_snapshots" ADD CONSTRAINT "active_snapshots_shipping_sane" CHECK ("active_market_snapshots"."asking_shipping" IS NULL OR ("active_market_snapshots"."asking_shipping" >= 0 AND "active_market_snapshots"."asking_shipping" <= 1000000));--> statement-breakpoint
ALTER TABLE "active_market_snapshots" ADD CONSTRAINT "active_snapshots_qty_nonneg" CHECK ("active_market_snapshots"."active_qty" IS NULL OR "active_market_snapshots"."active_qty" >= 0);--> statement-breakpoint
ALTER TABLE "active_market_snapshots" ADD CONSTRAINT "active_snapshots_sample_nonneg" CHECK ("active_market_snapshots"."sample_size" IS NULL OR "active_market_snapshots"."sample_size" >= 0);--> statement-breakpoint
INSERT INTO "active_market_snapshots" (
  "part_id", "asking_price", "asking_shipping", "active_qty", "source", "sample_size", "captured_at"
)
SELECT "part_id", "price", "shipping", "legacy_qty", "source", "sample_size", "captured_at"
FROM "market_snapshots"
WHERE "source" = 'ebay_browse';--> statement-breakpoint
DELETE FROM "market_snapshots" WHERE "source" = 'ebay_browse';--> statement-breakpoint
ALTER TABLE "market_snapshots" DROP CONSTRAINT IF EXISTS "snapshots_qty_nonneg";--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_legacy_qty_nonneg" CHECK ("market_snapshots"."legacy_qty" IS NULL OR "market_snapshots"."legacy_qty" >= 0);--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_sold_qty_nonneg" CHECK ("market_snapshots"."sold_qty" IS NULL OR "market_snapshots"."sold_qty" >= 0);--> statement-breakpoint
ALTER TABLE "ebay_sync_runs" ADD COLUMN "sold_snapshots_written" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ebay_sync_runs" ADD COLUMN "active_snapshots_written" integer DEFAULT 0 NOT NULL;
