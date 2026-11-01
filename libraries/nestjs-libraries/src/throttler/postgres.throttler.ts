import { ThrottlerStorage } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { stateStore } from '../state/postgres.state';

export class PostgresThrottlerStorage implements ThrottlerStorage {
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ) {
    const id = `${throttlerName}:${key}`;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await stateStore.client.$transaction(
          async (tx) => {
            const now = new Date();
            let row = await tx.apiRateLimit.findUnique({ where: { key: id } });
            if (!row)
              row = await tx.apiRateLimit.create({
                data: {
                  key: id,
                  hits: 0,
                  expiresAt: new Date(now.getTime() + ttl),
                },
              });
            if (row.blockedUntil && row.blockedUntil > now)
              return {
                totalHits: row.hits,
                timeToExpire: Math.max(
                  0,
                  Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000)
                ),
                isBlocked: true,
                timeToBlockExpire: Math.ceil(
                  (row.blockedUntil.getTime() - now.getTime()) / 1000
                ),
              };
            const reset = row.expiresAt <= now || !!row.blockedUntil;
            const hits = reset ? 1 : row.hits + 1;
            const expiresAt = reset
              ? new Date(now.getTime() + ttl)
              : row.expiresAt;
            const blockedUntil =
              hits > limit ? new Date(now.getTime() + blockDuration) : null;
            await tx.apiRateLimit.update({
              where: { key: id },
              data: { hits, expiresAt, blockedUntil },
            });
            return {
              totalHits: hits,
              timeToExpire: Math.ceil(
                (expiresAt.getTime() - now.getTime()) / 1000
              ),
              isBlocked: !!blockedUntil,
              timeToBlockExpire: blockedUntil
                ? Math.ceil(blockDuration / 1000)
                : 0,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          !['P2034', 'P2002'].includes(error.code) ||
          attempt === 9
        )
          throw error;
      }
    }
    throw new Error('Rate-limit transaction could not commit.');
  }
}
