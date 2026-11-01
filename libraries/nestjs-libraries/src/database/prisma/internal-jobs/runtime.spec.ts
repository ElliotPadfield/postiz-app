import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { InternalJobsRepository } from './internal.jobs.repository';
import { InternalJobsService } from './internal.jobs.service';
import { PostsRepository } from '../posts/posts.repository';
import { PostgresWorker } from './postgres.worker';
import { PostgresStateStore, stateStore } from '../../../state/postgres.state';
import { PostgresThrottlerStorage } from '../../../throttler/postgres.throttler';

jest.mock('../posts/posts.service', () => ({ PostsService: class {} }));
jest.mock('../../../integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('../../../integrations/refresh.integration.service', () => ({
  RefreshIntegrationService: class {},
}));
jest.mock('../notifications/notification.service', () => ({
  NotificationService: class {},
}));
jest.mock('../webhooks/webhooks.service', () => ({
  WebhooksService: class {},
}));
jest.mock('../insights/insights.service', () => ({
  InsightsService: class {},
}));
jest.mock('../../../integrations/social.abstract', () => ({
  PublishedWithError: class extends Error {},
}));

const url = process.env.POSTIZ_QUEUE_TEST_DATABASE_URL;
if (
  !url ||
  url !== process.env.DATABASE_URL ||
  new URL(url).hostname !== '127.0.0.1' ||
  new URL(url).pathname !== '/postiz_queue_test'
)
  throw new Error('Use pnpm test:internal-jobs');

describe('Internal runtime integration', () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const model = { model: db } as any;
  const queue = new InternalJobsService(new InternalJobsRepository(model));
  const repo = new PostsRepository(
    model,
    model,
    model,
    model,
    model,
    model,
    db as any
  );
  const store = new PostgresStateStore(db);
  const provider = {
    editor: 'normal',
    post: jest.fn(),
    postPending: jest.fn(),
    comment: jest.fn(),
    checkPostStatus: jest.fn(),
    finalizePost: jest.fn(),
  };
  const notifications = { inAppNotification: jest.fn() };
  const posts = {
    updateTags: jest.fn(async (_org, list) => list),
    updateMedia: jest.fn(async () => []),
  };
  let worker: PostgresWorker;
  const create = (
    channel = 'fc-ig',
    content = 'Futurecraft video',
    batchId?: string
  ) =>
    repo.createOrUpdatePost(
      'schedule',
      channel.startsWith('fc') ? 'futurecraft' : 'personal',
      new Date(Date.now() - 1000).toISOString(),
      {
        integration: { id: channel },
        settings: { __type: 'mock' },
        value: [{ content, image: [], delay: 0 }],
      } as any,
      [],
      'WEB',
      undefined,
      false,
      batchId
    );

  beforeAll(async () => {
    for (const id of ['futurecraft', 'personal'])
      await db.organization.upsert({
        where: { id },
        create: { id, name: id },
        update: {},
      });
    for (const [id, org] of [
      ['fc-ig', 'futurecraft'],
      ['fc-yt', 'futurecraft'],
      ['personal-x', 'personal'],
      ['personal-li', 'personal'],
    ])
      await db.integration.upsert({
        where: { id },
        create: {
          id,
          organizationId: org,
          internalId: id,
          name: id,
          type: 'social',
          providerIdentifier: 'mock',
          token: 'TEST_ONLY_NO_REAL_CREDENTIAL',
        },
        update: {},
      });
  });
  beforeEach(async () => {
    await db.internalJob.deleteMany();
    await db.postExecution.deleteMany();
    await db.metricSnapshot.deleteMany();
    await db.post.deleteMany();
    await db.transientState.deleteMany();
    await db.apiRateLimit.deleteMany();
    jest.clearAllMocks();
    await db.integration.updateMany({ data: { disabled: false } });
    provider.postPending.mockImplementation(async (_id, _token, list) => [
      {
        id: list[0].id,
        postId: 'live-id',
        releaseURL: 'https://example.com/post',
        status: 'success',
      },
    ]);
    worker = new PostgresWorker(
      db as any,
      queue,
      posts as any,
      { getSocialIntegration: () => provider } as any,
      {} as any,
      notifications as any,
      {} as any,
      { getWebhooks: async () => [] } as any
    );
  });
  afterAll(async () => {
    await stateStore.client.$disconnect();
    await db.$disconnect();
  });
  afterEach(() => jest.restoreAllMocks());

  it('saves posts and queue intent atomically; separate platforms keep independent jobs', async () => {
    const first = await create('fc-ig', 'Futurecraft video', 'fc-batch');
    const second = await create('fc-yt', 'Futurecraft video', 'fc-batch');
    expect(await db.internalJob.count()).toBe(2);
    expect(first.posts[0].batchId).toBe(second.posts[0].batchId);
    const job = await queue.claim('PUBLISH');
    await worker.execute(job!);
    expect(provider.postPending).toHaveBeenCalledTimes(1);
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: job!.targetId } })).state
    ).toBe('PUBLISHED');
    expect(
      (await db.internalJob.findUniqueOrThrow({ where: { id: job!.id } })).state
    ).toBe('COMPLETED');
    expect(await db.internalJob.count({ where: { state: 'QUEUED' } })).toBe(1);
  });

  it('keeps personal content separate and fences cross-workspace edits', async () => {
    const x = await create(
      'personal-x',
      'Short personal thought',
      'personal-x-batch'
    );
    const linkedin = await create(
      'personal-li',
      'Longer professional story',
      'personal-li-batch'
    );
    expect(x.posts[0].content).not.toBe(linkedin.posts[0].content);
    expect(x.posts[0].batchId).not.toBe(linkedin.posts[0].batchId);
    await expect(
      repo.createOrUpdatePost(
        'draft',
        'futurecraft',
        new Date().toISOString(),
        {
          integration: { id: 'fc-ig' },
          value: [{ id: x.posts[0].id, content: 'overwrite', image: [] }],
          settings: {},
        } as any,
        [],
        'WEB'
      )
    ).rejects.toThrow('another workspace');
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: x.posts[0].id } }))
        .content
    ).toBe('Short personal thought');
  });

  it('reschedules, drafts and deletes without leaving an orphan publish job', async () => {
    const {
      posts: [post],
    } = await create();
    const future = new Date(Date.now() + 3600_000);
    await repo.changeDate('futurecraft', post.id, future.toISOString(), false);
    expect(await queue.claim('PUBLISH')).toBeNull();
    expect((await db.internalJob.findFirstOrThrow()).runAt).toEqual(future);
    await repo.setScheduledState('futurecraft', post.id, 'DRAFT');
    expect((await db.internalJob.findFirstOrThrow()).state).toBe('CANCELLED');
    await repo.setScheduledState('futurecraft', post.id, 'QUEUE');
    expect((await db.internalJob.findFirstOrThrow()).state).toBe('QUEUED');
    await repo.deletePost('futurecraft', post.group);
    expect((await db.internalJob.findFirstOrThrow()).state).toBe('CANCELLED');
  });

  it('rolls back an edit racing a claimed publish', async () => {
    const {
      posts: [post],
    } = await create();
    await queue.claim('PUBLISH');
    await expect(
      repo.changeDate(
        'futurecraft',
        post.id,
        new Date(Date.now() + 3600_000).toISOString(),
        false
      )
    ).rejects.toThrow('in progress');
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).publishDate
    ).toEqual(post.publishDate);
    await expect(repo.deletePost('futurecraft', post.group)).rejects.toThrow(
      'in progress'
    );
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).deletedAt
    ).toBeNull();
  });

  it('persists a pending upload and resumes status checks without uploading twice', async () => {
    const {
      posts: [post],
    } = await create();
    provider.postPending.mockResolvedValueOnce([
      {
        id: post.id,
        postId: '',
        releaseURL: '',
        status: 'pending',
        pendingData: { uploadId: 'upload-1' },
      },
    ]);
    provider.checkPostStatus.mockResolvedValueOnce({
      status: 'completed',
      postId: 'live-final',
      releaseURL: 'https://example.com/final',
    });
    await worker.execute((await queue.claim('PUBLISH'))!);
    expect(
      (await db.postExecution.findUniqueOrThrow({ where: { postId: post.id } }))
        .phase
    ).toBe('PENDING');
    await expect(
      repo.setScheduledState('futurecraft', post.id, 'DRAFT')
    ).rejects.toThrow('in progress');
    await db.internalJob.updateMany({
      data: { runAt: new Date(Date.now() - 1000) },
    });
    await worker.execute((await queue.claim('PUBLISH'))!);
    expect(provider.postPending).toHaveBeenCalledTimes(1);
    expect(provider.checkPostStatus).toHaveBeenCalledWith(
      'TEST_ONLY_NO_REAL_CREDENTIAL',
      { uploadId: 'upload-1' },
      expect.anything()
    );
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).releaseId
    ).toBe('live-final');
  });

  it('does not repeat a mutation after an uncertain result', async () => {
    const {
      posts: [post],
    } = await create();
    provider.postPending.mockRejectedValueOnce(
      new Error('Response lost after acceptance')
    );
    const job = (await queue.claim('PUBLISH'))!;
    await worker.execute(job);
    expect(
      (await db.internalJob.findUniqueOrThrow({ where: { id: job.id } })).state
    ).toBe('REVIEW');
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).state
    ).toBe('ERROR');
    expect(await queue.claim('PUBLISH')).toBeNull();
    expect(provider.postPending).toHaveBeenCalledTimes(1);
  });

  it('allows correction and rescheduling after a known preflight failure', async () => {
    const {
      posts: [post],
    } = await create();
    await db.integration.update({
      where: { id: 'fc-ig' },
      data: { disabled: true },
    });
    await worker.execute((await queue.claim('PUBLISH'))!);
    expect(provider.postPending).not.toHaveBeenCalled();
    expect((await db.internalJob.findFirstOrThrow()).state).toBe('FAILED');
    await db.integration.update({
      where: { id: 'fc-ig' },
      data: { disabled: false },
    });
    await repo.changeDate(
      'futurecraft',
      post.id,
      new Date(Date.now() - 1000).toISOString(),
      false
    );
    await worker.execute((await queue.claim('PUBLISH'))!);
    expect(provider.postPending).toHaveBeenCalledTimes(1);
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).state
    ).toBe('PUBLISHED');
  });

  it('retries a failed read-only status check without repeating the upload', async () => {
    const {
      posts: [post],
    } = await create();
    provider.postPending.mockResolvedValueOnce([
      {
        id: post.id,
        status: 'pending',
        pendingData: { uploadId: 'pending-read' },
      },
    ]);
    await worker.execute((await queue.claim('PUBLISH'))!);
    provider.checkPostStatus.mockRejectedValueOnce(
      new Error('Temporary status outage')
    );
    await db.internalJob.updateMany({ data: { runAt: new Date(0) } });
    await worker.execute((await queue.claim('PUBLISH'))!);
    expect((await db.internalJob.findFirstOrThrow()).state).toBe('QUEUED');
    provider.checkPostStatus.mockResolvedValueOnce({
      status: 'completed',
      postId: 'after-read-retry',
      releaseURL: 'https://example.com/published',
    });
    await db.internalJob.updateMany({ data: { runAt: new Date(0) } });
    await worker.execute((await queue.claim('PUBLISH'))!);
    expect(provider.postPending).toHaveBeenCalledTimes(1);
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).releaseId
    ).toBe('after-read-retry');
  });

  it('times out a hung mutation and fences its late response', async () => {
    const {
      posts: [post],
    } = await create();
    let resolve: (value: any) => void;
    provider.postPending.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    (worker as any).operationTimeoutMilliseconds = 30;
    await worker.execute((await queue.claim('PUBLISH'))!);
    expect((await db.internalJob.findFirstOrThrow()).state).toBe('REVIEW');
    resolve!([
      {
        id: post.id,
        postId: 'late-live-id',
        releaseURL: 'https://example.com/late',
        status: 'success',
      },
    ]);
    await new Promise((done) => setTimeout(done, 30));
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).state
    ).toBe('ERROR');
    expect((await db.internalJob.findFirstOrThrow()).state).toBe('REVIEW');
  });

  it('never begins finalize after its durable marker write outlives the operation deadline', async () => {
    const {
      posts: [post],
    } = await create();
    provider.postPending.mockResolvedValueOnce([
      {
        id: post.id,
        status: 'pending',
        pendingData: { uploadId: 'finalize-deadline' },
      },
    ]);
    await worker.execute((await queue.claim('PUBLISH'))!);
    await db.internalJob.updateMany({ data: { runAt: new Date(0) } });
    provider.checkPostStatus.mockResolvedValueOnce({
      status: 'ready',
      pendingData: { uploadId: 'ready-finalize' },
    });
    const update = db.postExecution.update.bind(db.postExecution);
    const delayed = jest
      .spyOn(db.postExecution, 'update')
      .mockImplementationOnce(async (args: any) => {
        await new Promise((done) => setTimeout(done, 100));
        return update(args);
      });
    (worker as any).operationTimeoutMilliseconds = 50;
    await worker.execute((await queue.claim('PUBLISH'))!);
    expect(delayed).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phase: 'MUTATING' }),
      })
    );
    await new Promise((done) => setTimeout(done, 150));
    expect(provider.finalizePost).not.toHaveBeenCalled();
    expect(provider.postPending).toHaveBeenCalledTimes(1);
  });

  it('records a manually confirmed result without publishing or sending remaining comments', async () => {
    const {
      posts: [post],
    } = await create();
    provider.postPending.mockRejectedValueOnce(new Error('Result unknown'));
    await worker.execute((await queue.claim('PUBLISH'))!);
    await expect(
      repo.confirmPublished(
        'personal',
        post.id,
        'live-id',
        'https://example.com/live'
      )
    ).rejects.toThrow();
    await repo.confirmPublished(
      'futurecraft',
      post.id,
      'live-id',
      'https://example.com/live'
    );
    expect((await db.internalJob.findFirstOrThrow()).state).toBe('COMPLETED');
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).releaseId
    ).toBe('live-id');
    expect(provider.postPending).toHaveBeenCalledTimes(1);
    expect(await queue.claim('PUBLISH')).toBeNull();
  });

  it('queues a delayed comment only after its parent is published', async () => {
    const {
      posts: [root],
    } = await create('personal-x');
    const child = await db.post.create({
      data: {
        integrationId: 'personal-x',
        organizationId: 'personal',
        parentPostId: root.id,
        group: root.group,
        content: 'Follow-up',
        settings: '{}',
        image: '[]',
        publishDate: root.publishDate,
        delay: 5,
      },
    });
    await worker.execute((await queue.claim('PUBLISH'))!);
    const childJob = await db.internalJob.findFirstOrThrow({
      where: { targetId: child.id },
    });
    expect(childJob.runAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(await queue.claim('PUBLISH')).toBeNull();
    await db.internalJob.update({
      where: { id: childJob.id },
      data: { runAt: new Date(Date.now() - 1000) },
    });
    provider.comment.mockResolvedValueOnce([
      {
        id: child.id,
        postId: 'comment-id',
        releaseURL: 'https://example.com/comment',
        status: 'success',
      },
    ]);
    await worker.execute((await queue.claim('PUBLISH'))!);
    expect(provider.postPending).toHaveBeenCalledTimes(1);
    expect(provider.comment).toHaveBeenCalledTimes(1);
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: child.id } })).releaseId
    ).toBe('comment-id');
  });

  it('atomically consumes OAuth state and excludes expired or duplicate locks', async () => {
    await store.set('oauth-state', 'verifier', 'EX', 60);
    const consumed = await Promise.all(
      Array.from({ length: 10 }, () => store.consume('oauth-state'))
    );
    expect(consumed.filter((s) => s === 'verifier')).toHaveLength(1);
    const locks = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.set('lock', 'owner', 'EX', 60, 'NX')
      )
    );
    expect(locks.filter(Boolean)).toHaveLength(1);
    await db.transientState.update({
      where: { key: 'lock' },
      data: { expiresAt: new Date(0) },
    });
    expect(await store.get('lock')).toBeNull();
    expect(await store.set('lock', 'new-owner', 'EX', 60, 'NX')).toBe('OK');
  });

  it('retains concurrent upload-list appends and applies expiration', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.rpush('uploads', `media-${i}`))
    );
    expect(await store.lrange('uploads', 0, -1)).toHaveLength(10);
    await db.transientState.update({
      where: { key: 'uploads' },
      data: { expiresAt: new Date(0) },
    });
    expect(await store.lrange('uploads', 0, -1)).toEqual([]);
    await store.rpush('uploads', 'new-media');
    expect(await store.lrange('uploads', 0, -1)).toEqual(['new-media']);
  });

  it('does not let an expired lock owner delete a newer lock', async () => {
    await store.set('refresh-owner', 'first', 'EX', 60, 'NX');
    await db.transientState.update({
      where: { key: 'refresh-owner' },
      data: { expiresAt: new Date(0) },
    });
    await store.set('refresh-owner', 'second', 'EX', 60, 'NX');
    expect(await store.delIfValue('refresh-owner', 'first')).toBe(0);
    expect(await store.get('refresh-owner')).toBe('second');
  });

  it('continues publishing while an analytics job is waiting', async () => {
    (worker as any).lastSweep = Date.now();
    await create();
    await queue.schedule(
      'futurecraft',
      'analytics-target',
      'ANALYTICS',
      new Date(0)
    );
    let release: () => void;
    (worker as any).collectAnalytics = async (job) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await queue.finish(job);
    };
    const firstTick = worker.tick();
    while (!release) await new Promise((done) => setTimeout(done, 1));
    // Wait for the first publish while the analytics request stays pending.
    for (
      let attempt = 0;
      attempt < 100 &&
      (await db.post.count({ where: { state: 'PUBLISHED' } })) !== 1;
      attempt++
    )
      await new Promise((done) => setTimeout(done, 5));
    await create('fc-yt');
    await worker.tick();
    release!();
    await firstTick;
    expect(await db.post.count({ where: { state: 'PUBLISHED' } })).toBe(2);
  });

  it('shares API rate limits across independent storage instances', async () => {
    const one = new PostgresThrottlerStorage();
    const two = new PostgresThrottlerStorage();
    expect(
      (await one.increment('org', 60_000, 2, 60_000, 'api')).isBlocked
    ).toBe(false);
    expect(
      (await two.increment('org', 60_000, 2, 60_000, 'api')).totalHits
    ).toBe(2);
    expect(
      (await one.increment('org', 60_000, 2, 60_000, 'api')).isBlocked
    ).toBe(true);
    expect(
      (await two.increment('org', 60_000, 2, 60_000, 'api')).isBlocked
    ).toBe(true);
  });
});
