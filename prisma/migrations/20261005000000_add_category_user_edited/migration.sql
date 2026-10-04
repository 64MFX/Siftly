-- AlterTable: categories renamed / re-described by the user are not overwritten by default seeding
ALTER TABLE "Category" ADD COLUMN "userEdited" BOOLEAN NOT NULL DEFAULT false;
