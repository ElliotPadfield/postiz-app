import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { InternalJob, PrismaClient } from '@prisma/client';
import { InternalJobsModule } from './internal.jobs.module';
import { InternalJobsService } from './internal.jobs.service';

// Real Postgres integration tests. Refuse arbitrary/inherited connection strings.
const testUrl = process.env.POSTIZ_QUEUE_TEST_DATABASE_URL;
if (!testUrl || testUrl !== process.env.DATABASE_URL)
  throw new Error('Use pnpm test:internal-jobs.');
const parsed = new URL(testUrl);
if (
  parsed.hostname !== '127.0.0.1' ||
  parsed.pathname !== '/postiz_queue_test'
) {
  throw new Error(
    'Internal job tests require the disposable loopback database.'
  );
}

describe('Postgres internal jobs', () => {
  const db = new PrismaClient({ datasources: { db: { url: testUrl } } });
  const now = new Date('2030-01-01T12:00:00Z');
  const later = (milliseconds: number) =>
    new Date(now.getTime() + milliseconds);
  let module: TestingModule;
  let jobs: InternalJobsService;
  const read = (job: InternalJob) =>
    db.internalJob.findUniqueOrThrow({ where: { id: job.id } });

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [InternalJobsModule],
    }).compile();
    await module.init();
    jobs = module.get(InternalJobsService);
  });
  beforeEach(async () => {
    await db.internalJob.deleteMany();
  });
  afterAll(async () => {
    await module?.close();
    await db.$disconnect();
  });

  it('does not claim a job before its scheduled UTC time', async () => {
    const job = await jobs.schedule('org', 'post', 'PUBLISH', later(30_000));
    expect(await jobs.claim('PUBLISH', now)).toBeNull();
    expect((await jobs.claim('PUBLISH', later(30_000)))?.id).toBe(job.id);
  });

  it('lets only one of sixteen concurrent workers claim the same publish', async () => {
    await jobs.schedule('org', 'post', 'PUBLISH', now);
    const claimed = await Promise.all(
      Array.from({ length: 16 }, () => jobs.claim('PUBLISH', now))
    );
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect((await db.internalJob.findFirstOrThrow()).attempts).toBe(1);
  });

  it('keeps a single job identity when the calendar reschedules it', async () => {
    const job = await jobs.schedule('org', 'post', 'PUBLISH', now);
    const edited = await jobs.schedule(
      'org',
      'post',
      'PUBLISH',
      later(120_000)
    );
    expect(edited.id).toBe(job.id);
    expect(await db.internalJob.count()).toBe(1);
    expect(await jobs.claim('PUBLISH', later(60_000))).toBeNull();
  });

  it('fences cancellation by organization and never claims cancelled jobs', async () => {
    const job = await jobs.schedule('org', 'post', 'PUBLISH', now);
    expect(await jobs.cancel('other-org', job.id)).toBe(false);
    expect(await jobs.cancel('org', job.id)).toBe(true);
    expect(await jobs.claim('PUBLISH', now)).toBeNull();
  });

  it('rejects editing or cancelling a running publish', async () => {
    const job = await jobs.schedule('org', 'post', 'PUBLISH', now);
    await jobs.claim('PUBLISH', now);
    expect(await jobs.cancel('org', job.id)).toBe(false);
    await expect(
      jobs.schedule('org', 'post', 'PUBLISH', later(30_000))
    ).rejects.toThrow('running');
  });

  it('does not requeue a publish that may already have reached the platform', async () => {
    await jobs.schedule('org', 'post', 'PUBLISH', now);
    const claimed = (await jobs.claim('PUBLISH', now))!;
    expect(await jobs.fail(claimed, later(1_000))).toBe(true);
    expect((await read(claimed)).state).toBe('REVIEW');
    expect(await jobs.claim('PUBLISH', later(3_600_000))).toBeNull();
    await expect(jobs.schedule('org', 'post', 'PUBLISH', now)).rejects.toThrow(
      'review'
    );
  });

  it('recovers a dead publish worker to review and rejects its late completion', async () => {
    await jobs.schedule('org', 'post', 'PUBLISH', now);
    const claimed = (await jobs.claim('PUBLISH', now))!;
    expect(await jobs.recoverExpired(later(60_000))).toEqual({
      review: 1,
      failed: 0,
      retried: 0,
    });
    expect((await read(claimed)).failureCode).toBe('PUBLISH_WORKER_LOST');
    expect(await jobs.finish(claimed, later(60_001))).toBe(false);
    expect(await jobs.claim('PUBLISH', later(120_000))).toBeNull();
  });

  it('extends a live lease but never revives an expired lease', async () => {
    await jobs.schedule('org', 'post', 'PUBLISH', now);
    const claimed = (await jobs.claim('PUBLISH', now))!;
    expect(await jobs.renew(claimed, later(30_000))).toBe(true);
    expect(await jobs.recoverExpired(later(60_000))).toEqual({
      review: 0,
      failed: 0,
      retried: 0,
    });
    expect(await jobs.renew(claimed, later(90_000))).toBe(false);
    expect(await jobs.finish(claimed, later(90_000))).toBe(false);
  });

  it('does not shorten a lease when an earlier heartbeat arrives late', async () => {
    await jobs.schedule('org', 'post', 'PUBLISH', now);
    const claimed = (await jobs.claim('PUBLISH', now))!;
    expect(await jobs.renew(claimed, later(30_000))).toBe(true);
    expect(await jobs.renew(claimed, later(10_000))).toBe(true);
    expect((await read(claimed)).leaseExpiresAt).toEqual(later(90_000));
    expect(await jobs.recoverExpired(later(75_000))).toEqual({
      review: 0,
      failed: 0,
      retried: 0,
    });
    expect(await jobs.finish(claimed, later(80_000))).toBe(true);
  });

  it('never schedules an already completed publish again', async () => {
    await jobs.schedule('org', 'post', 'PUBLISH', now);
    const claimed = (await jobs.claim('PUBLISH', now))!;
    expect(await jobs.finish(claimed, later(1_000))).toBe(true);
    await expect(jobs.schedule('org', 'post', 'PUBLISH', now)).rejects.toThrow(
      'published'
    );
  });

  it('retries safe analytics reads with delay and stops after five attempts', async () => {
    const scheduled = await jobs.schedule('org', 'post', 'ANALYTICS', now);
    let time = now;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claimed = (await jobs.claim('ANALYTICS', time))!;
      expect(claimed.attempts).toBe(attempt);
      await jobs.fail(claimed, time);
      const saved = await read(scheduled);
      expect(saved.state).toBe(attempt === 5 ? 'FAILED' : 'QUEUED');
      if (attempt < 5) expect(await jobs.claim('ANALYTICS', time)).toBeNull();
      time = saved.runAt;
    }
    expect(await jobs.claim('ANALYTICS', later(86_400_000))).toBeNull();
  });

  it('reclaims an expired read lease and fences the old worker', async () => {
    await jobs.schedule('org', 'post', 'ANALYTICS', now);
    const first = (await jobs.claim('ANALYTICS', now))!;
    await jobs.recoverExpired(later(60_000));
    const second = (await jobs.claim('ANALYTICS', later(60_000)))!;
    expect(second.id).toBe(first.id);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await jobs.finish(first, later(61_000))).toBe(false);
    expect(await jobs.renew(first, later(61_000))).toBe(false);
    expect(await jobs.finish(second, later(61_000))).toBe(true);
  });

  it('exhausts read leases even when each worker crashes before reporting failure', async () => {
    await jobs.schedule('org', 'post', 'ANALYTICS', now);
    for (let attempt = 0; attempt < 5; attempt++) {
      const time = later(attempt * 60_000);
      expect(await jobs.claim('ANALYTICS', time)).not.toBeNull();
      await jobs.recoverExpired(later((attempt + 1) * 60_000));
    }
    expect((await db.internalJob.findFirstOrThrow()).state).toBe('FAILED');
    expect(await jobs.claim('ANALYTICS', later(86_400_000))).toBeNull();
  });

  it('survives closing the process connection without losing a waiting job', async () => {
    const scheduled = await jobs.schedule(
      'org',
      'post',
      'PUBLISH',
      later(30_000)
    );
    await module.close();
    module = await Test.createTestingModule({
      imports: [InternalJobsModule],
    }).compile();
    await module.init();
    jobs = module.get(InternalJobsService);
    expect((await jobs.claim('PUBLISH', later(30_000)))?.id).toBe(scheduled.id);
  });
});
