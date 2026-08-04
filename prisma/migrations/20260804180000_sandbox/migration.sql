-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('CREATED', 'POSTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED');

-- CreateTable
CREATE TABLE "SandboxPayment" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "orderId" TEXT,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "installments" INTEGER,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT NOT NULL,
    "pixCopiaECola" TEXT,
    "boletoLine" TEXT,
    "cardBrand" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxSubscription" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "customerId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "intervalDays" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "cyclesBilled" INTEGER NOT NULL DEFAULT 0,
    "nextChargeAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SandboxSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "cost" DECIMAL(12,2) NOT NULL,
    "etaDays" INTEGER NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "trackingCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SandboxPayment_groupId_idx" ON "SandboxPayment"("groupId");

-- CreateIndex
CREATE INDEX "SandboxPayment_orderId_idx" ON "SandboxPayment"("orderId");

-- CreateIndex
CREATE INDEX "SandboxSubscription_groupId_idx" ON "SandboxSubscription"("groupId");

-- CreateIndex
CREATE INDEX "Shipment_groupId_idx" ON "Shipment"("groupId");

-- CreateIndex
CREATE INDEX "Shipment_orderId_idx" ON "Shipment"("orderId");

-- CreateIndex
CREATE INDEX "TrackingEvent_shipmentId_idx" ON "TrackingEvent"("shipmentId");

-- AddForeignKey
ALTER TABLE "SandboxPayment" ADD CONSTRAINT "SandboxPayment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxPayment" ADD CONSTRAINT "SandboxPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxSubscription" ADD CONSTRAINT "SandboxSubscription_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

