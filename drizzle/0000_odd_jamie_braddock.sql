CREATE TYPE "public"."period" AS ENUM('1yr', '6m', '90d', '30d', '7d');--> statement-breakpoint
CREATE TYPE "public"."snapshot_source" AS ENUM('manual', 'ebay_browse', 'ebay_insights');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "ebay_sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"adapter" text,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"parts_processed" integer DEFAULT 0 NOT NULL,
	"parts_failed" integer DEFAULT 0 NOT NULL,
	"snapshots_written" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"part_id" integer NOT NULL,
	"period" "period" NOT NULL,
	"price" numeric(10, 2),
	"shipping" numeric(10, 2),
	"qty" integer,
	"source" "snapshot_source" DEFAULT 'manual' NOT NULL,
	"sample_size" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parts" (
	"id" serial PRIMARY KEY NOT NULL,
	"mpn" text NOT NULL,
	"description" text NOT NULL,
	"category" text,
	"inventory_qty" integer DEFAULT 0 NOT NULL,
	"cost_basis" numeric(10, 2),
	"ship_cost" numeric(10, 2),
	"target_margin_pct" numeric(5, 2),
	"source_url" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"fee_pct" numeric(5, 2) DEFAULT '13.25' NOT NULL,
	"fee_fixed" numeric(10, 2) DEFAULT '0.30' NOT NULL,
	"default_ship_cost" numeric(10, 2) DEFAULT '12.00' NOT NULL,
	"target_margin_pct" numeric(5, 2) DEFAULT '35.00' NOT NULL,
	"min_margin_pct" numeric(5, 2) DEFAULT '15.00' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_started_idx" ON "ebay_sync_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "snapshots_part_period_captured_idx" ON "market_snapshots" USING btree ("part_id","period","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "parts_mpn_unique" ON "parts" USING btree ("mpn");--> statement-breakpoint
CREATE INDEX "parts_active_idx" ON "parts" USING btree ("active");