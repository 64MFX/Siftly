-- AlterTable: local archive state for bookmarks
ALTER TABLE "Bookmark" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "Bookmark" ADD COLUMN "archiveStatus" TEXT;
ALTER TABLE "Bookmark" ADD COLUMN "archiveError" TEXT;

-- AlterTable: archived poster frame for videos / GIFs
ALTER TABLE "MediaItem" ADD COLUMN "localThumbnailPath" TEXT;

-- CreateIndex
CREATE INDEX "Bookmark_archiveStatus_idx" ON "Bookmark"("archiveStatus");
