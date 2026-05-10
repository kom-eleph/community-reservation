-- AlterTable
ALTER TABLE "reservations"
  ADD COLUMN "hasAllergy"   BOOLEAN,
  ADD COLUMN "carbonatedNg" BOOLEAN,
  ADD COLUMN "allergyNote"  TEXT;
