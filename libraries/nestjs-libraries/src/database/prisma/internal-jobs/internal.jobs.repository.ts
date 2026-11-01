import { Injectable } from '@nestjs/common';
import {
  InternalJob,
  InternalJobKind,
  InternalJobState,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaRepository } from '../prisma.service';

@Injectable()
export class InternalJobsRepository {
  constructor(private _jobs: PrismaRepository<'internalJob'>) {}

  async schedule(
    organizationId: string,
    targetId: string,
    kind: InternalJobKind,
    runAt: Date
  ) {
    // A publish target has a single durable identity across edits/restarts.
    // A completed or uncertain publish cannot be scheduled again implicitly.
    const editable: InternalJobState[] = ['QUEUED', 'CANCELLED'];
    if (kind === 'ANALYTICS') editable.push('COMPLETED', 'FAILED');

    const key = { organizationId, kind, targetId };
    const existing = await this._jobs.model.internalJob.findUnique({
      where: { organizationId_kind_targetId: key },
    });

    if (!existing) {
      try {
        return await this._jobs.model.internalJob.create({
          data: { ...key, runAt },
        });
      } catch (error) {
        // Another scheduler won the unique-key race; let the caller retry the
        // edit after observing the existing job, rather than overwrite it.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          return null;
        }
        throw error;
      }
    }

    const updated = await this._jobs.model.internalJob.updateMany({
      where: {
        id: existing.id,
        version: existing.version,
        state: { in: editable },
      },
      data: {
        state: 'QUEUED',
        runAt,
        attempts: 0,
        failureCode: null,
        leaseToken: null,
        leaseExpiresAt: null,
        version: { increment: 1 },
      },
    });
    return updated.count
      ? this._jobs.model.internalJob.findUnique({ where: { id: existing.id } })
      : null;
  }

  async cancel(organizationId: string, id: string) {
    const result = await this._jobs.model.internalJob.updateMany({
      where: { id, organizationId, state: 'QUEUED' },
      data: { state: 'CANCELLED', version: { increment: 1 } },
    });
    return result.count === 1;
  }

  async claim(kind: InternalJobKind, now: Date, leaseMilliseconds: number) {
    // Optimistic claiming keeps all app queries in Prisma. It deliberately
    // favours a small internal queue over raw SQL/SKIP LOCKED throughput.
    for (let contention = 0; contention < 10; contention++) {
      const candidate = await this._jobs.model.internalJob.findFirst({
        where: { kind, state: 'QUEUED', runAt: { lte: now } },
        orderBy: [{ runAt: 'asc' }, { id: 'asc' }],
      });
      if (!candidate) return null;

      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
      const claimed = await this._jobs.model.internalJob.updateMany({
        where: {
          id: candidate.id,
          version: candidate.version,
          state: 'QUEUED',
        },
        data: {
          state: 'RUNNING',
          leaseToken,
          leaseExpiresAt,
          attempts: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (claimed.count) {
        return {
          ...candidate,
          state: InternalJobState.RUNNING,
          leaseToken,
          leaseExpiresAt,
          attempts: candidate.attempts + 1,
          version: candidate.version + 1,
        };
      }
    }
    return null;
  }

  async renew(job: InternalJob, now: Date, leaseMilliseconds: number) {
    const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
    const result = await this._jobs.model.internalJob.updateMany({
      where: {
        id: job.id,
        state: 'RUNNING',
        leaseToken: job.leaseToken,
        leaseExpiresAt: { gt: now, lt: leaseExpiresAt },
      },
      data: { leaseExpiresAt },
    });
    if (result.count === 1) return true;
    // A delayed heartbeat must not shorten the expiry written by a newer one.
    // An already-longer live lease still belongs to this worker.
    return !!(await this._jobs.model.internalJob.findFirst({
      where: {
        id: job.id,
        state: 'RUNNING',
        leaseToken: job.leaseToken,
        leaseExpiresAt: { gte: leaseExpiresAt },
      },
      select: { id: true },
    }));
  }

  async finish(job: InternalJob, now: Date) {
    const result = await this._jobs.model.internalJob.updateMany({
      where: {
        id: job.id,
        state: 'RUNNING',
        leaseToken: job.leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data: { state: 'COMPLETED', leaseToken: null, leaseExpiresAt: null },
    });
    return result.count === 1;
  }

  async fail(job: InternalJob, now: Date, retryAt: Date, maxAttempts: number) {
    const state =
      job.kind === 'PUBLISH'
        ? 'REVIEW'
        : job.attempts >= maxAttempts
        ? 'FAILED'
        : 'QUEUED';
    const result = await this._jobs.model.internalJob.updateMany({
      where: {
        id: job.id,
        state: 'RUNNING',
        leaseToken: job.leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        state,
        runAt: retryAt,
        leaseToken: null,
        leaseExpiresAt: null,
        failureCode:
          job.kind === 'PUBLISH'
            ? 'PUBLISH_OUTCOME_UNCONFIRMED'
            : 'ANALYTICS_READ_FAILED',
      },
    });
    return result.count === 1;
  }

  async recoverExpired(now: Date, maxAttempts: number) {
    // A dead worker may already have sent a mutation. Never requeue it.
    const publish = await this._jobs.model.internalJob.updateMany({
      where: {
        kind: 'PUBLISH',
        state: 'RUNNING',
        leaseExpiresAt: { lte: now },
      },
      data: {
        state: 'REVIEW',
        leaseToken: null,
        leaseExpiresAt: null,
        failureCode: 'PUBLISH_WORKER_LOST',
      },
    });
    const exhausted = await this._jobs.model.internalJob.updateMany({
      where: {
        kind: 'ANALYTICS',
        state: 'RUNNING',
        leaseExpiresAt: { lte: now },
        attempts: { gte: maxAttempts },
      },
      data: {
        state: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        failureCode: 'ANALYTICS_RETRIES_EXHAUSTED',
      },
    });
    const reads = await this._jobs.model.internalJob.updateMany({
      where: {
        kind: 'ANALYTICS',
        state: 'RUNNING',
        leaseExpiresAt: { lte: now },
        attempts: { lt: maxAttempts },
      },
      data: {
        state: 'QUEUED',
        runAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        failureCode: 'ANALYTICS_WORKER_LOST',
      },
    });
    return {
      review: publish.count,
      failed: exhausted.count,
      retried: reads.count,
    };
  }
}
