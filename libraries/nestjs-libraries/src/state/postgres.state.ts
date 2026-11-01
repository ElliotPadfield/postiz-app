import { Prisma, PrismaClient } from '@prisma/client';

// Shared by callback controllers as well as Nest services. A single lazy client
// per process, not an in-memory fallback; state survives restarts and workers.
export class PostgresStateStore {
  constructor(readonly client = new PrismaClient()) {}

  async get(key: string) {
    return (
      (
        await this.client.transientState.findFirst({
          where: { key, expiresAt: { gt: new Date() } },
        })
      )?.value ?? null
    );
  }

  async consume(key: string) {
    try {
      return (
        await this.client.transientState.delete({
          where: { key, expiresAt: { gt: new Date() } },
        })
      ).value;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      )
        return null;
      throw error;
    }
  }

  async set(
    key: string,
    value: string,
    mode: 'EX' = 'EX',
    seconds = 3600,
    condition?: 'NX'
  ) {
    if (mode !== 'EX' || !Number.isFinite(seconds) || seconds <= 0)
      throw new Error('State requires a positive expiry.');
    const now = new Date();
    const data = {
      value: String(value),
      items: [],
      expiresAt: new Date(now.getTime() + seconds * 1000),
    };
    if (condition === 'NX') {
      const expired = await this.client.transientState.updateMany({
        where: { key, expiresAt: { lte: now } },
        data,
      });
      if (expired.count) return 'OK';
      try {
        await this.client.transientState.create({ data: { key, ...data } });
        return 'OK';
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          return null;
        throw error;
      }
    }
    await this.client.transientState.upsert({
      where: { key },
      create: { key, ...data },
      update: data,
    });
    return 'OK';
  }

  async del(key: string) {
    return (await this.client.transientState.deleteMany({ where: { key } }))
      .count;
  }

  async delIfValue(key: string, value: string) {
    return (
      await this.client.transientState.deleteMany({ where: { key, value } })
    ).count;
  }

  async rpush(key: string, value: string) {
    const now = new Date();
    await this.client.transientState.deleteMany({
      where: { key, expiresAt: { lte: now } },
    });
    const row = await this.client.transientState.upsert({
      where: { key },
      create: {
        key,
        items: [value],
        expiresAt: new Date(now.getTime() + 3600_000),
      },
      update: { items: { push: value } },
    });
    return row.items.length;
  }

  async lrange(key: string, start: number, end: number) {
    const row = await this.client.transientState.findFirst({
      where: { key, expiresAt: { gt: new Date() } },
    });
    return (row?.items || []).slice(start, end === -1 ? undefined : end + 1);
  }

  async expire(key: string, seconds: number) {
    return (
      await this.client.transientState.updateMany({
        where: { key, expiresAt: { gt: new Date() } },
        data: { expiresAt: new Date(Date.now() + seconds * 1000) },
      })
    ).count;
  }

  async cleanup() {
    await this.client.transientState.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    await this.client.apiRateLimit.deleteMany({
      where: {
        expiresAt: { lt: new Date(Date.now() - 86400_000) },
        OR: [{ blockedUntil: null }, { blockedUntil: { lt: new Date() } }],
      },
    });
  }
}

export const stateStore = new PostgresStateStore();
