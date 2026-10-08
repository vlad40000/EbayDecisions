-- New Price: the reference price of a part when new, carried by the shared
-- manual-research CSV (`New Price`). Additive and nullable — existing rows stay
-- unknown (NULL), never zero. It is not cost basis, a sold comp, an asking
-- price, shipping, or a margin target, and no decision math reads it.
ALTER TABLE "parts" ADD COLUMN "new_price" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_new_price_sane" CHECK ("parts"."new_price" IS NULL OR ("parts"."new_price" >= 0 AND "parts"."new_price" <= 1000000));
