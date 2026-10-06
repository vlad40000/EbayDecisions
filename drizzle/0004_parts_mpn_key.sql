-- D1 MPN identity key. parts.mpn stays the display spelling; parts.mpn_key is
-- trim -> uppercase -> strip every non-[A-Z0-9] character (src/lib/mpn.ts).
--
-- Additive and collision-safe: the column is added nullable and backfilled,
-- then audited. If any existing MPN has no A-Z/0-9 characters, or two existing
-- MPNs collapse to the same key, the migration aborts and lists them. Nothing
-- is deleted, merged, or picked as a winner — resolve the rows by hand first.
-- The column add is IF NOT EXISTS so the migration can be re-run once fixed.
ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "mpn_key" text;--> statement-breakpoint
UPDATE "parts" SET "mpn_key" = regexp_replace(upper(btrim("mpn")), '[^A-Z0-9]', '', 'g');--> statement-breakpoint
DO $$
DECLARE
  blank_report text;
  collision_report text;
BEGIN
  SELECT string_agg(format('id %s %L', "id", "mpn"), '; ' ORDER BY "id")
    INTO blank_report
    FROM "parts"
    WHERE "mpn_key" = '';
  IF blank_report IS NOT NULL THEN
    RAISE EXCEPTION 'parts.mpn_key migration aborted: these parts have an MPN with no A-Z/0-9 characters: %', blank_report;
  END IF;

  SELECT string_agg(collision, '; ' ORDER BY "mpn_key")
    INTO collision_report
    FROM (
      SELECT "mpn_key",
             format('%s <- %s', "mpn_key", string_agg(format('id %s %L', "id", "mpn"), ', ' ORDER BY "id")) AS collision
        FROM "parts"
        GROUP BY "mpn_key"
        HAVING count(*) > 1
    ) collisions;
  IF collision_report IS NOT NULL THEN
    RAISE EXCEPTION 'parts.mpn_key migration aborted: existing MPNs collapse to the same D1 key and must be resolved by hand: %', collision_report;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "parts" ALTER COLUMN "mpn_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "parts_mpn_key_unique" ON "parts" USING btree ("mpn_key");--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_mpn_key_nonblank" CHECK ("parts"."mpn_key" <> '');
