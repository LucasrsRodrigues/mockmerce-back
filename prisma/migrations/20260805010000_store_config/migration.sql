-- AlterTable: campos de configuração da loja no GroupConfig
ALTER TABLE "GroupConfig" ADD COLUMN "storeName" TEXT;
ALTER TABLE "GroupConfig" ADD COLUMN "storeDescription" TEXT;
ALTER TABLE "GroupConfig" ADD COLUMN "logoUrl" TEXT;
ALTER TABLE "GroupConfig" ADD COLUMN "supportEmail" TEXT;
ALTER TABLE "GroupConfig" ADD COLUMN "whatsapp" TEXT;
ALTER TABLE "GroupConfig" ADD COLUMN "instagram" TEXT;
ALTER TABLE "GroupConfig" ADD COLUMN "primaryColor" TEXT;
ALTER TABLE "GroupConfig" ADD COLUMN "address" TEXT;
ALTER TABLE "GroupConfig" ADD COLUMN "cnpj" TEXT;
