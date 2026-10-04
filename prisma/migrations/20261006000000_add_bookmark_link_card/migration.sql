-- AlterTable: preview of the page a post links to, shown on bookmark cards and read by the categorizer
ALTER TABLE "Bookmark" ADD COLUMN "linkCard" TEXT;
