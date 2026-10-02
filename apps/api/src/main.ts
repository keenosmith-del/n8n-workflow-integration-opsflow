import './telemetry';
import 'reflect-metadata';
import { NestFactory, APP_GUARD } from '@nestjs/core';
import {
  Module,
  Global,
  ValidationPipe,
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { Db } from './db';
import { AuthGuard, AuthModule } from './auth';
import { ProcurementModule } from './procurement';
import { OperationsModule } from './operations';
import { EventsModule } from './events';
const logger = pino({
  base: { service: 'opsflow-api' },
  redact: ['password', 'authorization', 'secret', 'callbackKey'],
});
@Catch()
class Errors implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : error.code === 'P2025'
          ? 404
          : error.code === 'P2002'
            ? 409
            : 500;
    if (status >= 500)
      logger.error({ error: error.message, correlationId: req.correlationId }, 'API failure');
    res
      .status(status)
      .json({
        statusCode: status,
        message:
          error instanceof HttpException
            ? error.getResponse()
            : status === 409
              ? 'Conflicting state'
              : status === 404
                ? 'Record not found'
                : 'Internal server error',
        correlationId: req.correlationId,
      });
  }
}
@Global()
@Module({ providers: [Db], exports: [Db] })
class DatabaseModule {}
@Module({
  imports: [DatabaseModule, AuthModule, ProcurementModule, OperationsModule, EventsModule],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
class AppModule {}
async function bootstrap() {
  for (const key of [
    'DATABASE_URL',
    'JWT_SECRET',
    'WORKFLOW_TOKEN',
    'CREDENTIAL_ENCRYPTION_KEY',
    'SIMULATOR_API_KEY',
    'REDIS_URL',
    'RABBITMQ_URL',
    'N8N_URL',
    'SIMULATOR_URL',
  ])
    if (!process.env[key]) throw new Error(`Missing required environment variable ${key}`);
  if (process.env.JWT_SECRET!.length < 32 || process.env.WORKFLOW_TOKEN!.length < 32)
    throw new Error('JWT_SECRET and WORKFLOW_TOKEN must have at least 32 characters');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.use(helmet());
  app.enableCors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173' });
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  app.use((req: any, res: any, next: any) => {
    const header = req.headers['x-correlation-id'];
    req.correlationId =
      typeof header === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(header) ? header : randomUUID();
    res.setHeader('x-correlation-id', req.correlationId);
    trace.getActiveSpan()?.setAttribute('opsflow.correlation_id', req.correlationId);
    const started = Date.now();
    res.on('finish', () =>
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          correlationId: req.correlationId,
          durationMs: Date.now() - started,
        },
        'HTTP request',
      ),
    );
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new Errors());
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('OpsFlow API')
      .setDescription(
        'Authoritative procurement state, operations and authenticated n8n callbacks. Amounts are ZAR cents.',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, doc);
  await app.listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
bootstrap().catch((e) => {
  logger.fatal({ error: e.message }, 'Startup failed');
  process.exit(1);
});
