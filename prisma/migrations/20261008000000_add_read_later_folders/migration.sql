-- CreateTable: the user's own folders for the Read Later list
CREATE TABLE "ReadLaterFolder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ReadLaterFolder_name_key" ON "ReadLaterFolder"("name");

-- AlterTable: the Read Later folder a bookmark is filed in (deleting the folder leaves it Unsorted)
ALTER TABLE "Bookmark" ADD COLUMN "readLaterFolderId" TEXT REFERENCES "ReadLaterFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Bookmark_readLaterFolderId_idx" ON "Bookmark"("readLaterFolderId");
