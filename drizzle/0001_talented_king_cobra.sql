ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_price_sane" CHECK ("market_snapshots"."price" IS NULL OR ("market_snapshots"."price" >= 0 AND "market_snapshots"."price" <= 1000000));--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_shipping_sane" CHECK ("market_snapshots"."shipping" IS NULL OR ("market_snapshots"."shipping" >= 0 AND "market_snapshots"."shipping" <= 1000000));--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "snapshots_qty_nonneg" CHECK ("market_snapshots"."qty" IS NULL OR "market_snapshots"."qty" >= 0);--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_inventory_qty_nonneg" CHECK ("parts"."inventory_qty" >= 0);--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_cost_basis_sane" CHECK ("parts"."cost_basis" IS NULL OR ("parts"."cost_basis" >= 0 AND "parts"."cost_basis" <= 1000000));--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_ship_cost_sane" CHECK ("parts"."ship_cost" IS NULL OR ("parts"."ship_cost" >= 0 AND "parts"."ship_cost" <= 1000000));--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_target_margin_sane" CHECK ("parts"."target_margin_pct" IS NULL OR ("parts"."target_margin_pct" >= 0 AND "parts"."target_margin_pct" < 100));--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_single_row" CHECK ("settings"."id" = 1);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_fee_pct_sane" CHECK ("settings"."fee_pct" >= 0 AND "settings"."fee_pct" < 100);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_fee_fixed_sane" CHECK ("settings"."fee_fixed" >= 0 AND "settings"."fee_fixed" <= 1000);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_ship_cost_sane" CHECK ("settings"."default_ship_cost" >= 0 AND "settings"."default_ship_cost" <= 1000000);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_target_margin_sane" CHECK ("settings"."target_margin_pct" >= 0 AND "settings"."target_margin_pct" < 100);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_min_margin_sane" CHECK ("settings"."min_margin_pct" >= 0 AND "settings"."min_margin_pct" < 100);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_floor_below_target" CHECK ("settings"."min_margin_pct" <= "settings"."target_margin_pct");