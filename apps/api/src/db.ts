import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
@Injectable()
export class Db extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
  async serial<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let i = 0; i < 5; i++)
      try {
        return await this.$transaction(fn, { isolationLevel: 'Serializable', timeout: 15000 });
      } catch (e: any) {
        if (e.code !== 'P2034' || i === 4) throw e;
        await new Promise((r) => setTimeout(r, 25 * (i + 1)));
      }
    throw new Error('Transaction failed');
  }
}
