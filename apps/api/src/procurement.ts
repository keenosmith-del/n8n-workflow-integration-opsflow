import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Query,
  Module,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiHeader } from '@nestjs/swagger';
import { Prisma, RequestStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Db } from './db';
import { Roles, Internal } from './auth';
import { RequestDto, DecisionDto, CallbackDto } from '@opsflow/contracts';
const include = {
  employee: { select: { id: true, name: true, email: true } },
  execution: { include: { definition: true, exceptions: true } },
  approval: { include: { manager: { select: { id: true, name: true, email: true } } } },
  quotations: { include: { supplier: true } },
  purchaseOrder: { include: { supplier: true } },
  audits: { orderBy: { createdAt: 'asc' as const } },
};
export async function audit(
  tx: Prisma.TransactionClient,
  requestId: string | null,
  actorId: string,
  action: string,
  correlationId: string,
  data: any = {},
) {
  await tx.auditEvent.create({ data: { requestId, actorId, action, correlationId, data } });
}
export async function emit(tx: Prisma.TransactionClient, ex: any, request: any) {
  await tx.outboxEvent.create({
    data: {
      executionId: ex.id,
      attempt: ex.attempt,
      phase: ex.phase,
      payload: {
        executionId: ex.id,
        requestId: request.id,
        attempt: ex.attempt,
        phase: ex.phase,
        callbackKey: ex.callbackKey,
        correlationId: ex.correlationId,
        amountCents: request.amountCents,
        department: request.department,
        scenario: request.scenario,
        definitionVersion: ex.definition.version,
      },
    },
  });
}
@Injectable()
export class ProcurementService {
  constructor(public db: Db) {}
  async create(dto: RequestDto, user: any, correlationId: string) {
    return this.db.serial(async (tx) => {
      const definition = await tx.workflowDefinition.findFirstOrThrow({
        orderBy: { version: 'desc' },
      });
      const request = await tx.procurementRequest.create({ data: { ...dto, employeeId: user.id } });
      const ex = await tx.execution.create({
        data: {
          requestId: request.id,
          definitionId: definition.id,
          correlationId,
          callbackKey: randomUUID(),
          deadline: new Date(Date.now() + 120000),
        },
        include: { definition: true },
      });
      await emit(tx, ex, request);
      await audit(tx, request.id, user.id, 'REQUEST_CREATED', correlationId, {
        amountCents: dto.amountCents,
        version: definition.version,
      });
      return request;
    });
  }
  async visible(id: string, user: any) {
    const r = await this.db.procurementRequest.findUnique({ where: { id }, include });
    if (!r) throw new NotFoundException('Request not found');
    if (user.role === 'EMPLOYEE' && r.employeeId !== user.id) throw new ForbiddenException();
    if (r.execution) {
      const { callbackKey, ...execution } = r.execution;
      return { ...r, execution };
    }
    return r;
  }
  list(user: any, q?: string, status?: string) {
    if (status && !Object.values(RequestStatus).includes(status as RequestStatus))
      throw new BadRequestException('Unknown status');
    return this.db.procurementRequest.findMany({
      where: {
        ...(user.role === 'EMPLOYEE' ? { employeeId: user.id } : {}),
        ...(status ? { status: status as RequestStatus } : {}),
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: 'insensitive' } },
                { execution: { correlationId: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: {
        employee: { select: { name: true } },
        execution: { select: { id: true, status: true, correlationId: true } },
        purchaseOrder: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  async release(tx: Prisma.TransactionClient, r: any) {
    if (r.reservedCents > 0) {
      await tx.budget.update({
        where: { department: r.department },
        data: { reservedCents: { decrement: r.reservedCents } },
      });
      await tx.procurementRequest.update({ where: { id: r.id }, data: { reservedCents: 0 } });
    }
  }
  async fail(
    tx: Prisma.TransactionClient,
    ex: any,
    r: any,
    reason: string,
    status: RequestStatus = 'FAILED',
  ) {
    await this.release(tx, r);
    await tx.execution.update({ where: { id: ex.id }, data: { status, error: reason } });
    await tx.procurementRequest.update({ where: { id: r.id }, data: { status } });
    if (status === 'FAILED' || status === 'TIMED_OUT')
      await tx.exceptionRecord.create({
        data: { executionId: ex.id, attempt: ex.attempt, reason },
      });
    await audit(tx, r.id, 'system', status, ex.correlationId, { reason, attempt: ex.attempt });
  }
  async callback(dto: CallbackDto) {
    if (dto.phase === 'COLLECT' && !dto.error && typeof dto.financeOk !== 'boolean')
      throw new BadRequestException('COLLECT requires a finance result');
    return this.db.serial(async (tx) => {
      const ex = await tx.execution.findUnique({
        where: { id: dto.executionId },
        include: { request: { include: { approval: true, quotations: true } }, definition: true },
      });
      if (!ex) throw new NotFoundException('Execution not found');
      if (
        ex.attempt !== dto.attempt ||
        ex.callbackKey !== dto.callbackKey ||
        ex.phase !== dto.phase
      )
        throw new ConflictException('Stale or invalid callback');
      const prior = await tx.callbackReceipt.findUnique({
        where: {
          executionId_attempt_phase: { executionId: ex.id, attempt: ex.attempt, phase: ex.phase },
        },
      });
      if (prior) return { duplicate: true, status: ex.status };
      if (!['QUEUED', 'RUNNING', 'APPROVED'].includes(ex.status))
        throw new ConflictException('Execution no longer accepts callbacks');
      if (ex.deadline.getTime() < Date.now()) {
        await this.fail(tx, ex, ex.request, 'Callback deadline expired', 'TIMED_OUT');
        return { status: 'TIMED_OUT' };
      }
      if (dto.phase === 'FINALIZE' && ex.request.status !== 'APPROVED')
        throw new ConflictException('Approval is required before finalization');
      await tx.callbackReceipt.create({
        data: { executionId: ex.id, attempt: ex.attempt, phase: ex.phase },
      });
      await tx.execution.update({
        where: { id: ex.id },
        data: { n8nExecutionId: dto.n8nExecutionId || null },
      });
      if (dto.error) {
        await this.fail(tx, ex, ex.request, dto.error);
        return { status: 'FAILED' };
      }
      if (dto.phase === 'COLLECT') {
        if (dto.financeOk !== true) {
          await this.fail(
            tx,
            ex,
            ex.request,
            'Finance declined the available budget',
            'INSUFFICIENT_BUDGET',
          );
          return { status: 'INSUFFICIENT_BUDGET' };
        }
        const quotes = dto.quotes || [];
        if (!quotes.length || new Set(quotes.map((q) => q.supplierId)).size !== quotes.length) {
          await this.fail(tx, ex, ex.request, 'No valid supplier quotations');
          return { status: 'FAILED' };
        }
        const selected = [...quotes].sort((a, b) => a.amountCents - b.amountCents)[0];
        if (selected.amountCents > ex.request.amountCents) {
          await this.fail(tx, ex, ex.request, 'Quotations exceed the requested maximum');
          return { status: 'FAILED' };
        }
        const reserved =
          await tx.$executeRaw`UPDATE "Budget" SET "reservedCents"="reservedCents"+${selected.amountCents} WHERE "department"=${ex.request.department} AND "limitCents"-"reservedCents"-"spentCents">=${selected.amountCents}`;
        if (reserved !== 1) {
          await this.fail(
            tx,
            ex,
            ex.request,
            'Budget became unavailable before reservation',
            'INSUFFICIENT_BUDGET',
          );
          return { status: 'INSUFFICIENT_BUDGET' };
        }
        for (const quote of quotes)
          await tx.quotation.create({
            data: { ...quote, requestId: ex.requestId, attempt: ex.attempt },
          });
        const config = ex.definition.config as any;
        const rule = [...config.rules]
          .sort((a, b) => b.minCents - a.minCents)
          .find((x) => ex.request.amountCents >= x.minCents);
        if (!rule) throw new BadRequestException('No matching approval rule');
        const dueAt = new Date(Date.now() + config.approvalTimeoutMinutes * 60000);
        await tx.approval.upsert({
          where: { requestId: ex.requestId },
          create: { requestId: ex.requestId, managerId: rule.managerId, dueAt },
          update: {
            managerId: rule.managerId,
            decision: null,
            comment: null,
            decidedAt: null,
            dueAt,
          },
        });
        await tx.procurementRequest.update({
          where: { id: ex.requestId },
          data: { status: 'AWAITING_APPROVAL', reservedCents: selected.amountCents },
        });
        await tx.execution.update({
          where: { id: ex.id },
          data: { status: 'AWAITING_APPROVAL', deadline: dueAt, error: null },
        });
        await audit(tx, ex.requestId, 'n8n', 'QUOTATIONS_RECEIVED', ex.correlationId, {
          quotes,
          attempt: ex.attempt,
          n8nExecutionId: dto.n8nExecutionId,
        });
        await audit(tx, ex.requestId, 'system', 'BUDGET_RESERVED', ex.correlationId, {
          amountCents: selected.amountCents,
        });
        await audit(tx, ex.requestId, 'system', 'APPROVAL_ROUTED', ex.correlationId, {
          managerId: rule.managerId,
          dueAt: dueAt.toISOString(),
        });
        return { status: 'AWAITING_APPROVAL' };
      }
      const quote = ex.request.quotations
        .filter((q) => q.attempt <= ex.attempt)
        .sort((a, b) => b.attempt - a.attempt || a.amountCents - b.amountCents)[0];
      if (!quote || ex.request.reservedCents !== quote.amountCents)
        throw new ConflictException('Budget reservation and quotation must match');
      const po = await tx.purchaseOrder.create({
        data: {
          requestId: ex.requestId,
          supplierId: quote.supplierId,
          amountCents: quote.amountCents,
          number: `PO-${ex.requestId.toUpperCase()}`,
        },
      });
      await tx.budget.update({
        where: { department: ex.request.department },
        data: {
          reservedCents: { decrement: quote.amountCents },
          spentCents: { increment: quote.amountCents },
        },
      });
      await tx.procurementRequest.update({
        where: { id: ex.requestId },
        data: { status: 'COMPLETED', reservedCents: 0 },
      });
      await tx.execution.update({
        where: { id: ex.id },
        data: { status: 'COMPLETED', error: null },
      });
      await audit(tx, ex.requestId, 'n8n', 'PURCHASE_ORDER_CREATED', ex.correlationId, {
        purchaseOrderId: po.id,
        number: po.number,
        amountCents: po.amountCents,
      });
      return { status: 'COMPLETED', purchaseOrder: po };
    });
  }
  async decide(id: string, dto: DecisionDto, user: any) {
    return this.db.serial(async (tx) => {
      const r = await tx.procurementRequest.findUnique({
        where: { id },
        include: { approval: true, execution: { include: { definition: true } } },
      });
      if (!r || !r.approval || !r.execution) throw new NotFoundException('Approval not found');
      if (r.approval.managerId !== user.id)
        throw new ForbiddenException('Only the assigned manager can decide');
      if (r.status !== 'AWAITING_APPROVAL' || r.approval.decision)
        throw new ConflictException('This approval is already closed');
      if (r.approval.dueAt.getTime() < Date.now()) throw new ConflictException('Approval expired');
      await tx.approval.update({
        where: { id: r.approval.id },
        data: { decision: dto.decision, comment: dto.comment, decidedAt: new Date() },
      });
      if (dto.decision === 'REJECT') {
        await this.release(tx, r);
        await tx.procurementRequest.update({ where: { id }, data: { status: 'REJECTED' } });
        await tx.execution.update({ where: { id: r.execution.id }, data: { status: 'REJECTED' } });
      } else {
        await tx.procurementRequest.update({ where: { id }, data: { status: 'APPROVED' } });
        const ex = await tx.execution.update({
          where: { id: r.execution.id },
          data: {
            status: 'APPROVED',
            phase: 'FINALIZE',
            callbackKey: randomUUID(),
            deadline: new Date(Date.now() + 120000),
          },
          include: { definition: true },
        });
        await emit(tx, ex, r);
      }
      await audit(
        tx,
        id,
        user.id,
        dto.decision === 'APPROVE' ? 'REQUEST_APPROVED' : 'REQUEST_REJECTED',
        r.execution.correlationId,
        { comment: dto.comment },
      );
      return { status: dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
    });
  }
  async retry(id: string, user: any) {
    return this.db.serial(async (tx) => {
      const ex = await tx.execution.findUnique({
        where: { id },
        include: { request: { include: { approval: true, quotations: true } }, definition: true },
      });
      if (!ex) throw new NotFoundException();
      if (!['FAILED', 'TIMED_OUT'].includes(ex.status))
        throw new ConflictException('Only failed or timed out executions can be retried');
      let phase = 'COLLECT';
      let status: RequestStatus = 'QUEUED';
      if (ex.request.approval?.decision === 'APPROVE') {
        const quote = ex.request.quotations.sort(
          (a, b) => b.attempt - a.attempt || a.amountCents - b.amountCents,
        )[0];
        if (!quote) throw new ConflictException('Approved request has no quotation');
        const count =
          await tx.$executeRaw`UPDATE "Budget" SET "reservedCents"="reservedCents"+${quote.amountCents} WHERE "department"=${ex.request.department} AND "limitCents"-"reservedCents"-"spentCents">=${quote.amountCents}`;
        if (count !== 1) throw new ConflictException('Budget cannot be re-reserved');
        await tx.procurementRequest.update({
          where: { id: ex.requestId },
          data: { reservedCents: quote.amountCents },
        });
        phase = 'FINALIZE';
        status = 'APPROVED';
      }
      const next = await tx.execution.update({
        where: { id },
        data: {
          attempt: { increment: 1 },
          phase,
          status,
          error: null,
          callbackKey: randomUUID(),
          deadline: new Date(Date.now() + 120000),
        },
        include: { definition: true },
      });
      // Controlled failure scenarios only fail attempt one; a manual retry demonstrates recovery.
      await tx.procurementRequest.update({ where: { id: ex.requestId }, data: { status } });
      await tx.exceptionRecord.updateMany({
        where: { executionId: id, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
      await emit(tx, next, ex.request);
      await audit(tx, ex.requestId, user.id, 'MANUAL_RETRY', ex.correlationId, {
        attempt: next.attempt,
        phase,
      });
      return { attempt: next.attempt, status };
    });
  }
  async expire(id: string, attempt: number, phase: string) {
    return this.db.serial(async (tx) => {
      const ex = await tx.execution.findUnique({ where: { id }, include: { request: true } });
      if (
        !ex ||
        ex.attempt !== attempt ||
        ex.phase !== phase ||
        !['QUEUED', 'RUNNING', 'APPROVED', 'AWAITING_APPROVAL'].includes(ex.status) ||
        ex.deadline.getTime() > Date.now()
      )
        return;
      await this.fail(
        tx,
        ex,
        ex.request,
        ex.status === 'AWAITING_APPROVAL'
          ? 'Approval deadline expired'
          : 'Integration callback deadline expired',
        'TIMED_OUT',
      );
    });
  }
}
@ApiBearerAuth()
@ApiTags('Procurement')
@Controller('requests')
export class ProcurementController {
  constructor(private svc: ProcurementService) {}
  @Get() list(@Req() req: any, @Query('q') q?: string, @Query('status') status?: string) {
    return this.svc.list(req.user, q, status);
  }
  @Roles('EMPLOYEE', 'ADMIN') @Post() create(@Body() dto: RequestDto, @Req() req: any) {
    return this.svc.create(dto, req.user, req.correlationId);
  }
  @Get(':id') detail(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: any) {
    return this.svc.visible(id, req.user);
  }
  @Roles('MANAGER') @Post(':id/decision') decision(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DecisionDto,
    @Req() req: any,
  ) {
    return this.svc.decide(id, dto, req.user);
  }
}
@ApiTags('Workflow callbacks')
@ApiHeader({ name: 'x-workflow-token', required: true })
@Internal()
@Controller('internal')
export class CallbackController {
  constructor(private svc: ProcurementService) {}
  @Post('callback') callback(@Body() dto: CallbackDto) {
    return this.svc.callback(dto);
  }
}
@Module({
  controllers: [ProcurementController, CallbackController],
  providers: [ProcurementService],
  exports: [ProcurementService],
})
export class ProcurementModule {}
