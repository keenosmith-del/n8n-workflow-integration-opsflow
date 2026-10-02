import {
  Controller,
  Get,
  Post,
  Put,
  Req,
  Param,
  Query,
  Body,
  Module,
  BadRequestException,
  NotFoundException,
  Injectable,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Db } from './db';
import { ProcurementModule, ProcurementService, audit } from './procurement';
import { Roles, Internal } from './auth';
import { WorkflowDto, IntegrationDto } from '@opsflow/contracts';
import { encrypt, decrypt } from './credentials';
@Injectable()
export class CredentialsService {
  constructor(private db: Db) {}
  async headers(name: string) {
    const c = await this.db.integrationConfig.findUniqueOrThrow({ where: { name } });
    if (!c.enabled) throw new BadRequestException(`${name} integration is disabled`);
    const secret = decrypt(c.encryptedSecret);
    if (c.authType === 'api-key') return { 'x-api-key': secret };
    const response = await fetch(`${process.env.SIMULATOR_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: c.clientId || '',
        client_secret: secret,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new BadRequestException('OAuth credential exchange failed');
    const token = (await response.json()) as any;
    return { Authorization: `Bearer ${token.access_token}` };
  }
}
@ApiBearerAuth()
@ApiTags('Operations')
@Controller()
export class OperationsController {
  constructor(
    private db: Db,
    private procurement: ProcurementService,
  ) {}
  @Get('me') me(@Req() req: any) {
    return req.user;
  }
  @Get('dashboard') async dashboard(@Req() req: any) {
    const where = req.user.role === 'EMPLOYEE' ? { employeeId: req.user.id } : {};
    const [statuses, orders, exceptions, budgets, latest] = await Promise.all([
      this.db.procurementRequest.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.db.purchaseOrder.aggregate({
        where: { request: where },
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      this.db.exceptionRecord.count({ where: { resolvedAt: null, execution: { request: where } } }),
      this.db.budget.findMany(),
      this.db.execution.findMany({
        where: { request: where },
        select: {
          id: true,
          status: true,
          correlationId: true,
          updatedAt: true,
          definition: { select: { version: true } },
          request: { select: { title: true, id: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
    ]);
    return { statuses, orders, exceptions, budgets, latest };
  }
  @Get('approvals') async approvals(@Req() req: any) {
    return this.db.approval.findMany({
      where: { managerId: req.user.id, decision: null, request: { status: 'AWAITING_APPROVAL' } },
      include: {
        request: {
          include: {
            quotations: { include: { supplier: true } },
            employee: { select: { name: true } },
          },
        },
      },
      orderBy: { dueAt: 'asc' },
    });
  }
  @Get('orders') orders(@Req() req: any) {
    return this.db.purchaseOrder.findMany({
      where: { request: req.user.role === 'EMPLOYEE' ? { employeeId: req.user.id } : {} },
      include: { supplier: true, request: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  @Get('executions') executions(
    @Req() req: any,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    return this.db.execution.findMany({
      where: {
        request: req.user.role === 'EMPLOYEE' ? { employeeId: req.user.id } : {},
        ...(status ? { status } : {}),
        ...(q ? { correlationId: { contains: q, mode: 'insensitive' } } : {}),
      },
      select: {
        id: true,
        requestId: true,
        status: true,
        phase: true,
        attempt: true,
        error: true,
        correlationId: true,
        n8nExecutionId: true,
        deadline: true,
        createdAt: true,
        updatedAt: true,
        definition: true,
        request: { select: { title: true } },
        exceptions: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  @Get('executions/:id') async execution(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: any,
  ) {
    const ex = await this.db.execution.findUnique({ where: { id }, select: { requestId: true } });
    if (!ex) throw new NotFoundException();
    const request = await this.procurement.visible(ex.requestId, req.user);
    return { execution: request.execution, audits: request.audits, requestId: request.id };
  }
  @Roles('ADMIN') @Post('executions/:id/retry') retry(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: any,
  ) {
    return this.procurement.retry(id, req.user);
  }
  @Roles('ADMIN') @Get('exceptions') exceptions() {
    return this.db.exceptionRecord.findMany({
      include: {
        execution: {
          select: {
            id: true,
            status: true,
            attempt: true,
            requestId: true,
            correlationId: true,
            request: { select: { title: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  @Roles('ADMIN') @Get('workflows') workflows() {
    return this.db.workflowDefinition.findMany({ orderBy: { version: 'desc' } });
  }
  @Roles('ADMIN') @Get('managers') managers() {
    return this.db.user.findMany({
      where: { role: 'MANAGER' },
      select: { id: true, name: true, email: true },
    });
  }
  @Roles('ADMIN') @Post('workflows') async workflow(@Body() dto: WorkflowDto, @Req() req: any) {
    if (
      !dto.rules.some((r) => r.minCents === 0) ||
      new Set(dto.rules.map((r) => r.minCents)).size !== dto.rules.length
    )
      throw new BadRequestException('Rules require a unique zero threshold and unique amounts');
    for (const rule of dto.rules)
      if (!(await this.db.user.findFirst({ where: { id: rule.managerId, role: 'MANAGER' } })))
        throw new BadRequestException('Routing rules must use manager users');
    return this.db.serial(async (tx) => {
      const latest = await tx.workflowDefinition.findFirstOrThrow({ orderBy: { version: 'desc' } });
      const next = await tx.workflowDefinition.create({
        data: {
          version: latest.version + 1,
          template: dto.template,
          config: {
            approvalTimeoutMinutes: dto.approvalTimeoutMinutes,
            rules: dto.rules.map((r) => ({ minCents: r.minCents, managerId: r.managerId })),
          },
        },
      });
      await audit(tx, null, req.user.id, 'WORKFLOW_VERSION_CREATED', req.correlationId, {
        version: next.version,
      });
      return next;
    });
  }
  @Roles('ADMIN') @Get('integrations') integrations() {
    return this.db.integrationConfig.findMany({
      select: { name: true, authType: true, clientId: true, enabled: true, updatedAt: true },
    });
  }
  @Roles('ADMIN') @Put('integrations') async integration(
    @Body() dto: IntegrationDto,
    @Req() req: any,
  ) {
    if (dto.authType === 'oauth2-client-credentials' && !dto.clientId)
      throw new BadRequestException('OAuth requires clientId');
    return this.db.serial(async (tx) => {
      const old = await tx.integrationConfig.findUniqueOrThrow({ where: { name: dto.name } });
      await tx.integrationConfig.update({
        where: { name: dto.name },
        data: {
          authType: dto.authType,
          clientId: dto.clientId || null,
          enabled: dto.enabled,
          encryptedSecret: dto.secret ? encrypt(dto.secret) : old.encryptedSecret,
        },
      });
      await audit(tx, null, req.user.id, 'INTEGRATION_CONFIGURED', req.correlationId, {
        name: dto.name,
        authType: dto.authType,
        enabled: dto.enabled,
      });
      return { saved: true };
    });
  }
  @Roles('ADMIN') @Get('audits') audits() {
    return this.db.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }
}
@Internal()
@ApiTags('Internal integration adapters')
@Controller('internal')
export class AdapterController {
  constructor(
    private db: Db,
    private credentials: CredentialsService,
  ) {}
  @Get('budget/:department') async budget(@Param('department') department: string) {
    const b = await this.db.budget.findUnique({ where: { department } });
    if (!b) throw new NotFoundException();
    return { availableCents: b.limitCents - b.reservedCents - b.spentCents };
  }
  @Get('credentials/:name') async credentialsFor(@Param('name') name: string) {
    if (!['finance', 'suppliers'].includes(name)) throw new NotFoundException();
    return { headers: await this.credentials.headers(name) };
  }
}
@Module({
  imports: [ProcurementModule],
  controllers: [OperationsController, AdapterController],
  providers: [CredentialsService],
})
export class OperationsModule {}
