-- AlterTable
ALTER TABLE "CountryIdentifierRequirement" ADD COLUMN     "requiredFor" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Rows written before this column keep requiring what they required until the next reseed.
UPDATE "CountryIdentifierRequirement"
SET "requiredFor" = CASE
  WHEN NOT "required" THEN ARRAY[]::TEXT[]
  WHEN "appliesTo" = 'BOTH' THEN ARRAY['COMPANY', 'INDIVIDUAL']
  ELSE ARRAY["appliesTo"]
END;
