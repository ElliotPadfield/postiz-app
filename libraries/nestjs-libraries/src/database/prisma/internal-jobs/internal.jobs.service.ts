import { ConflictException, Injectable } from '@nestjs/common';
import { InternalJob, InternalJobKind } from '@prisma/client';
import { InternalJobsRepository } from './internal.jobs.repository';

@Injectable()
export class InternalJobsService {
  // The worker renews the lease while a provider request is running.
  // Lost publish leases always require reconciliation, even after renewal.
  readonly leaseMilliseconds = 60_000;
  readonly maxReadAttempts = 5;

  constructor(private _jobs: InternalJobsRepository) {}

  async schedule(
    organizationId: string,
    targetId: string,
    kind: InternalJobKind,
    runAt: Date
  ) {
    if (!organizationId || !targetId || !Number.isFinite(runAt.getTime())) {
      throw new Error(
        'A job needs an organization, target and valid scheduled time.'
      );
    }
    const job = await this._jobs.schedule(
      organizationId,
      targetId,
      kind,
      runAt
    );
    if (!job) {
      throw new ConflictException(
        'This job is running, needs review, is already published, or changed during the edit.'
      );
    }
    return job;
  }

  cancel(organizationId: string, id: string) {
    return this._jobs.cancel(organizationId, id);
  }

  claim(kind: InternalJobKind, now = new Date()) {
    return this._jobs.claim(kind, now, this.leaseMilliseconds);
  }

  renew(job: InternalJob, now = new Date()) {
    return this._jobs.renew(job, now, this.leaseMilliseconds);
  }

  finish(job: InternalJob, now = new Date()) {
    return this._jobs.finish(job, now);
  }

  rejectBeforePublish(job: InternalJob) {
    return this._jobs.rejectBeforePublish(job);
  }
  cancelClaim(job: InternalJob) {
    return this._jobs.cancelClaim(job);
  }

  fail(job: InternalJob, now = new Date()) {
    const retryDelay = Math.min(60_000 * 2 ** (job.attempts - 1), 3_600_000);
    return this._jobs.fail(
      job,
      now,
      new Date(now.getTime() + retryDelay),
      this.maxReadAttempts
    );
  }

  recoverExpired(now = new Date()) {
    return this._jobs.recoverExpired(now, this.maxReadAttempts);
  }
}
