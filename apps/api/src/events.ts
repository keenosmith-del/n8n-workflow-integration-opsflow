import { Injectable, OnModuleInit, OnModuleDestroy, Controller, Get, Module } from '@nestjs/common';
import amqp, { ChannelModel, ConfirmChannel } from 'amqplib';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { Db } from './db';
import { ProcurementModule, ProcurementService } from './procurement';
import { Public, Roles } from './auth';
const log = pino({
  base: { service: 'opsflow-events' },
  redact: ['callbackKey', 'payload.callbackKey'],
});
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  private queue = new Queue('opsflow-jobs', { connection: this.redis });
  private worker!: Worker;
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private timers: NodeJS.Timeout[] = [];
  private publishing = false;
  private connecting = false;
  private stopped = false;
  constructor(
    private db: Db,
    private procurement: ProcurementService,
  ) {}
  async onModuleInit() {
    this.redis.on('error', (e) => log.error({ error: e.message }, 'Redis error'));
    this.worker = new Worker(
      'opsflow-jobs',
      async (job) => {
        if (job.name === 'deadline')
          return this.procurement.expire(job.data.id, job.data.attempt, job.data.phase);
        const data = job.data;
        const ex = await this.db.execution.findUnique({ where: { id: data.executionId } });
        if (
          !ex ||
          ex.attempt !== data.attempt ||
          ex.phase !== data.phase ||
          !['QUEUED', 'RUNNING', 'APPROVED'].includes(ex.status)
        )
          return;
        const path =
          data.phase === 'COLLECT' ? 'procurement-collect-v1' : 'procurement-finalize-v1';
        const response = await fetch(`${process.env.N8N_URL}/webhook/${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-workflow-token': process.env.WORKFLOW_TOKEN!,
            'x-correlation-id': data.correlationId,
          },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`n8n webhook returned HTTP ${response.status}`);
        await this.db.execution.updateMany({
          where: {
            id: ex.id,
            attempt: data.attempt,
            phase: data.phase,
            status: { in: ['QUEUED', 'APPROVED'] },
          },
          data: { status: 'RUNNING' },
        });
        log.info(
          { executionId: ex.id, attempt: data.attempt, correlationId: data.correlationId },
          'n8n accepted event',
        );
      },
      { connection: this.redis, concurrency: 4 },
    );
    this.worker.on('error', (e) => log.error({ error: e.message }, 'Worker error'));
    this.worker.on('failed', (job, error) => {
      log.error({ jobId: job?.id, error: error.message }, 'Background job failed');
      if (job && job.name === 'deliver' && job.attemptsMade >= Number(job.opts.attempts || 1))
        void this.deliveryFailed(job.data, error.message).catch((e) =>
          log.error({ error: e.message }, 'Failed to record delivery failure'),
        );
    });
    await this.connect();
    this.timers.push(
      setInterval(
        () =>
          void this.tick().catch((e) =>
            log.error({ error: e.message }, 'Outbox/reconciliation failed'),
          ),
        2000,
      ),
    );
    await this.tick();
  }
  private async deliveryFailed(data: any, reason: string) {
    await this.db.serial(async (tx) => {
      const ex = await tx.execution.findUnique({
        where: { id: data.executionId },
        include: { request: true },
      });
      if (
        ex &&
        ex.attempt === data.attempt &&
        ex.phase === data.phase &&
        ['QUEUED', 'RUNNING', 'APPROVED'].includes(ex.status)
      )
        await this.procurement.fail(
          tx,
          ex,
          ex.request,
          `Event delivery exhausted retries: ${reason}`,
        );
    });
  }
  private async connect() {
    if (this.channel || this.connecting || this.stopped) return;
    this.connecting = true;
    try {
      this.connection = await amqp.connect(process.env.RABBITMQ_URL!);
      this.connection.on('error', (e) => log.error({ error: e.message }, 'RabbitMQ error'));
      this.connection.on('close', () => {
        this.channel = undefined;
      });
      this.channel = await this.connection.createConfirmChannel();
      await this.channel.assertExchange('opsflow.domain', 'topic', { durable: true });
      await this.channel.assertQueue('opsflow.orchestration', { durable: true });
      await this.channel.bindQueue('opsflow.orchestration', 'opsflow.domain', 'procurement.*');
      await this.channel.assertExchange('opsflow.dead', 'fanout', { durable: true });
      await this.channel.assertQueue('opsflow.invalid', { durable: true });
      await this.channel.bindQueue('opsflow.invalid', 'opsflow.dead', '');
      await this.channel.prefetch(4);
      const channel = this.channel;
      await channel.consume('opsflow.orchestration', async (msg) => {
        if (!msg) return;
        try {
          const data = JSON.parse(msg.content.toString());
          const id = msg.properties.messageId;
          if (!id || !data.executionId || !['COLLECT', 'FINALIZE'].includes(data.phase)) {
            channel.publish('opsflow.dead', '', msg.content, { persistent: true });
            await channel.waitForConfirms();
            channel.ack(msg);
            return;
          }
          if (!(await this.db.inboxReceipt.findUnique({ where: { id } }))) {
            await this.queue.add('deliver', data, {
              jobId: id,
              attempts: 5,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: false,
              removeOnFail: false,
            });
            await this.db.inboxReceipt.upsert({ where: { id }, update: {}, create: { id } });
          }
          channel.ack(msg);
        } catch (e: any) {
          log.error({ error: e.message }, 'Consumer failure; event retained');
          channel.nack(msg, false, true);
        }
      });
      log.info('RabbitMQ consumer connected');
    } catch (e: any) {
      this.channel = undefined;
      log.error({ error: e.message }, 'RabbitMQ unavailable; will reconnect');
    } finally {
      this.connecting = false;
    }
  }
  private async tick() {
    await this.connect();
    if (this.channel && !this.publishing) {
      this.publishing = true;
      try {
        // Lock held through broker confirm: crashes after publish can repeat, never silently lose an event.
        await this.db.$transaction(
          async (tx) => {
            const events = await tx.$queryRaw<
              any[]
            >`SELECT * FROM "OutboxEvent" WHERE "publishedAt" IS NULL ORDER BY "createdAt" LIMIT 20 FOR UPDATE SKIP LOCKED`;
            for (const event of events) {
              this.channel!.publish(
                'opsflow.domain',
                `procurement.${event.phase.toLowerCase()}`,
                Buffer.from(JSON.stringify(event.payload)),
                {
                  persistent: true,
                  messageId: event.id,
                  correlationId: event.payload.correlationId,
                },
              );
              await this.channel!.waitForConfirms();
              await tx.outboxEvent.update({
                where: { id: event.id },
                data: { publishedAt: new Date() },
              });
            }
          },
          { timeout: 15000 },
        );
      } finally {
        this.publishing = false;
      }
    }
    // PostgreSQL deadlines are authoritative. Reconcile every active execution so a Redis restart cannot lose a timer.
    const active = await this.db.execution.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING', 'APPROVED', 'AWAITING_APPROVAL'] } },
    });
    for (const ex of active)
      await this.queue.add(
        'deadline',
        { id: ex.id, attempt: ex.attempt, phase: ex.phase },
        {
          jobId: `deadline-${ex.id}-${ex.attempt}-${ex.phase}-${ex.deadline.getTime()}`,
          delay: Math.max(0, ex.deadline.getTime() - Date.now()),
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      );
  }
  async status() {
    let redis = false,
      n8n = false;
    try {
      redis = (await this.redis.ping()) === 'PONG';
    } catch {}
    try {
      n8n = (await fetch(`${process.env.N8N_URL}/healthz`, { signal: AbortSignal.timeout(3000) }))
        .ok;
    } catch {}
    return {
      rabbitmq: !!this.channel,
      redis,
      n8n,
      jobs: await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      unpublishedEvents: await this.db.outboxEvent.count({ where: { publishedAt: null } }),
    };
  }
  async onModuleDestroy() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    await this.worker?.close();
    await this.queue.close();
    await this.redis.quit();
    await this.connection?.close();
  }
}
@Controller()
class HealthController {
  constructor(
    private db: Db,
    private events: EventsService,
  ) {}
  @Public() @Get('health') async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
  @Roles('ADMIN') @Get('operations/health') healthOps() {
    return this.events.status();
  }
}
@Module({
  imports: [ProcurementModule],
  providers: [EventsService],
  controllers: [HealthController],
})
export class EventsModule {}
