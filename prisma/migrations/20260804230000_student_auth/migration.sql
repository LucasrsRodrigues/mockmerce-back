-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "passwordHash" TEXT;

