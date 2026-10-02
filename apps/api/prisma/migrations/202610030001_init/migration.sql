-- CreateEnum
CREATE TYPE "Role" AS ENUM ('EMPLOYEE', 'MANAGER', 'ADMIN');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('QUEUED', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED', 'INSUFFICIENT_BUDGET', 'FAILED', 'TIMED_OUT');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "department" TEXT NOT NULL,
    "limitCents" INTEGER NOT NULL,
    "reservedCents" INTEGER NOT NULL DEFAULT 0,
    "spentCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("department")
);

-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "template" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementRequest" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "department" TEXT NOT NULL,
    "employeeId" UUID NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'QUEUED',
    "scenario" TEXT NOT NULL DEFAULT 'normal',
    "reservedCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "correlationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT NOT NULL DEFAULT 'COLLECT',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "callbackKey" TEXT NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "error" TEXT,
    "n8nExecutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quotation" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "supplierId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "deliveryDays" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "managerId" UUID NOT NULL,
    "decision" TEXT,
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "requestId" UUID,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxReceipt" (
    "id" UUID NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallbackReceipt" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallbackReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionRecord" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExceptionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConfig" (
    "name" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "clientId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConfig_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_version_key" ON "WorkflowDefinition"("version");

-- CreateIndex
CREATE INDEX "ProcurementRequest_status_createdAt_idx" ON "ProcurementRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_requestId_key" ON "Execution"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_correlationId_key" ON "Execution"("correlationId");

-- CreateIndex
CREATE INDEX "Execution_status_deadline_idx" ON "Execution"("status", "deadline");

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_requestId_supplierId_attempt_key" ON "Quotation"("requestId", "supplierId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_requestId_key" ON "Approval"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_number_key" ON "PurchaseOrder"("number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_requestId_key" ON "PurchaseOrder"("requestId");

-- CreateIndex
CREATE INDEX "AuditEvent_requestId_createdAt_idx" ON "AuditEvent"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_executionId_attempt_phase_key" ON "OutboxEvent"("executionId", "attempt", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "CallbackReceipt_executionId_attempt_phase_key" ON "CallbackReceipt"("executionId", "attempt", "phase");

-- AddForeignKey
ALTER TABLE "ProcurementRequest" ADD CONSTRAINT "ProcurementRequest_department_fkey" FOREIGN KEY ("department") REFERENCES "Budget"("department") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementRequest" ADD CONSTRAINT "ProcurementRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProcurementRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProcurementRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProcurementRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProcurementRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProcurementRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallbackReceipt" ADD CONSTRAINT "CallbackReceipt_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionRecord" ADD CONSTRAINT "ExceptionRecord_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Application-level append-only history, enforced even for raw SQL writes.
CREATE FUNCTION prevent_history_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'History records are immutable'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
CREATE TRIGGER workflow_version_immutable BEFORE UPDATE OR DELETE ON "WorkflowDefinition"
FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
ALTER TABLE "Budget" ADD CONSTRAINT budget_balanced CHECK (
 "reservedCents" >= 0 AND "spentCents" >= 0 AND "limitCents" >= "reservedCents" + "spentCents"
);
ALTER TABLE "ProcurementRequest" ADD CONSTRAINT positive_amount CHECK ("amountCents" > 0 AND "reservedCents" >= 0);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT positive_po_amount CHECK ("amountCents" > 0);
