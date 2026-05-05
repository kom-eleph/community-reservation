-- AlterTable: schedules に isHidden カラムを追加
-- 既存レコードはすべて false（公開中）として扱う
ALTER TABLE "schedules" ADD COLUMN "isHidden" BOOLEAN NOT NULL DEFAULT false;

-- note フィールドの [非公開] プレフィックスを isHidden フラグに移行
-- [非公開] で始まる note を持つレコードを isHidden=true に更新し、
-- note から [非公開] プレフィックスを除去する
UPDATE "schedules"
SET
  "isHidden" = true,
  "note" = NULLIF(TRIM(SUBSTRING("note" FROM 6)), '')
WHERE "note" LIKE '[非公開]%';

-- インデックス追加
CREATE INDEX "schedules_isHidden_idx" ON "schedules"("isHidden");
