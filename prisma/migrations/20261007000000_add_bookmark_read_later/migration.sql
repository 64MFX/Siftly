-- AlterTable: bookmarks the user put on the Read Later list, and when
ALTER TABLE "Bookmark" ADD COLUMN "readLaterAt" DATETIME;

-- CreateIndex
CREATE INDEX "Bookmark_readLaterAt_idx" ON "Bookmark"("readLaterAt");
