import { InsightsService } from '../insights/insights.service';
import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InternalJob, InternalJobKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { InternalJobsService } from './internal.jobs.service';
import { PostsService } from '../posts/posts.service';
import { IntegrationManager } from '../../../integrations/integration.manager';
import { RefreshIntegrationService } from '../../../integrations/refresh.integration.service';
import { NotificationService } from '../notifications/notification.service';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { PublishedWithError } from '../../../integrations/social.abstract';
import { stateStore } from '../../../state/postgres.state';
import { timer } from '@gitroom/helpers/utils/timer';
import { WebhooksService } from '../webhooks/webhooks.service';
import { getSsrfSafeDispatcher } from '../../../dtos/webhooks/ssrf.safe.dispatcher';

@Injectable()
export class PostgresWorker implements OnModuleInit, OnModuleDestroy {
  readonly operationTimeoutMilliseconds = 30 * 60_000;
  private logger = new Logger(PostgresWorker.name);
  private timer?: NodeJS.Timeout;
  private busyKinds = new Set<InternalJobKind>();
  private sweeping = false;
  private stopped = false;
  private lastSweep = 0;
  constructor(
    private db: PrismaService,
    private jobs: InternalJobsService,
    private posts: PostsService,
    private integrations: IntegrationManager,
    private refresh: RefreshIntegrationService,
    private notifications: NotificationService,
    private insights: InsightsService,
    private webhooks: WebhooksService
  ) {}

  onModuleInit() {
    if (process.env.RUN_WORKER !== 'true') return;
    this.timer = setInterval(
      () =>
        void this.tick().catch(() =>
          this.logger.error('Worker tick failed; will retry on next poll.')
        ),
      2000
    );
    this.timer.unref();
    void this.tick().catch(() =>
      this.logger.error('Initial worker tick failed.')
    );
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    // Do not release running publish leases: shutdown may interrupt a request.
    await stateStore.client.$disconnect();
  }

  async tick() {
    if (this.stopped) return;
    if (!this.sweeping && Date.now() - this.lastSweep > 60_000) {
      this.sweeping = true;
      this.lastSweep = Date.now();
      try {
        await this.sweep();
      } finally {
        this.sweeping = false;
      }
    }
    await Promise.all(
      (['PUBLISH', 'REFRESH', 'ANALYTICS'] as InternalJobKind[]).map(
        async (kind) => {
          if (this.busyKinds.has(kind)) return;
          this.busyKinds.add(kind);
          try {
            const job = await this.jobs.claim(kind);
            if (job) await this.execute(job);
          } finally {
            this.busyKinds.delete(kind);
          }
        }
      )
    );
  }

  async sweep() {
    await this.jobs.recoverExpired();
    // Recovery projects uncertainty into the existing calendar error state.
    const review = await this.db.internalJob.findMany({
      where: { kind: 'PUBLISH', state: 'REVIEW' },
      select: { targetId: true, organizationId: true },
    });
    for (const job of review)
      await this.db.post.updateMany({
        where: {
          id: job.targetId,
          organizationId: job.organizationId,
          state: 'QUEUE',
        },
        data: {
          state: 'ERROR',
          error:
            'Publish outcome unconfirmed. Check the platform before creating a replacement post.',
        },
      });

    // Import queued posts from an existing database without resetting any ledger.
    let cursor: string | undefined;
    do {
      const posts = await this.db.post.findMany({
        where: { state: 'QUEUE', deletedAt: null, parentPostId: null },
        select: { id: true, organizationId: true, publishDate: true },
        orderBy: { id: 'asc' },
        take: 200,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!posts.length) break;
      await this.db.internalJob.createMany({
        data: posts.map((p) => ({
          kind: 'PUBLISH',
          targetId: p.id,
          organizationId: p.organizationId,
          runAt: p.publishDate,
        })),
        skipDuplicates: true,
      });
      cursor = posts.length === 200 ? posts[posts.length - 1].id : undefined;
    } while (cursor);

    const channels = await this.db.integration.findMany({
      where: {
        deletedAt: null,
        disabled: false,
        refreshNeeded: false,
        inBetweenSteps: false,
        tokenExpiration: { not: null },
      },
    });
    for (const channel of channels) {
      if (
        !this.integrations.getSocialIntegration(channel.providerIdentifier)
          ?.refreshCron
      )
        continue;
      const existing = await this.db.internalJob.findUnique({
        where: {
          organizationId_kind_targetId: {
            organizationId: channel.organizationId,
            kind: 'REFRESH',
            targetId: channel.id,
          },
        },
      });
      if (existing && ['RUNNING', 'QUEUED'].includes(existing.state)) continue;
      await this.jobs.schedule(
        channel.organizationId,
        channel.id,
        'REFRESH',
        new Date(
          Math.max(Date.now(), channel.tokenExpiration.getTime() - 3600_000)
        )
      );
    }
    const published = await this.db.post.findMany({
      where: {
        state: 'PUBLISHED',
        parentPostId: null,
        deletedAt: null,
        releaseId: { not: null },
      },
      select: {
        id: true,
        organizationId: true,
        publishDate: true,
        integration: { select: { providerIdentifier: true } },
      },
      orderBy: { publishDate: 'desc' },
      take: 1000,
    });
    for (const post of published) {
      if (
        !this.integrations.getSocialIntegration(
          post.integration.providerIdentifier
        )?.postInsights
      )
        continue;
      const key = {
        organizationId: post.organizationId,
        kind: 'ANALYTICS' as const,
        targetId: post.id,
      };
      const current = await this.db.internalJob.findUnique({
        where: { organizationId_kind_targetId: key },
      });
      const age = Date.now() - post.publishDate.getTime();
      const cadence =
        age > 7 * 86400_000
          ? 86400_000
          : age > 3 * 86400_000
          ? 6 * 3600_000
          : 3600_000;
      if (
        current &&
        (['RUNNING', 'QUEUED'].includes(current.state) ||
          current.updatedAt.getTime() > Date.now() - cadence)
      )
        continue;
      try {
        await this.jobs.schedule(
          post.organizationId,
          post.id,
          'ANALYTICS',
          new Date()
        );
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
      }
    }
    await stateStore.cleanup();
  }

  async execute(job: InternalJob) {
    let lost = false;
    let deadline: NodeJS.Timeout | undefined;
    const heartbeat = setInterval(() => {
      void this.jobs
        .renew(job)
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {
          lost = true;
        });
    }, 15_000);
    const assertLease = async () => {
      if (lost || this.stopped || !(await this.jobs.renew(job)))
        throw new Error('Worker lease lost');
    };
    try {
      const operation = async () => {
        if (job.kind === 'PUBLISH') await this.publish(job, assertLease);
        else if (job.kind === 'REFRESH')
          await this.refreshChannel(job, assertLease);
        else await this.collectAnalytics(job, assertLease);
      };
      await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => {
              lost = true;
              reject(new Error('Job operation deadline exceeded'));
            },
            job.kind === 'PUBLISH'
              ? this.operationTimeoutMilliseconds
              : Math.min(this.operationTimeoutMilliseconds, 5 * 60_000)
          );
        }),
      ]);
    } catch (error) {
      // Deliberately do not persist arbitrary provider errors: they may contain tokens.
      const phase =
        job.kind === 'PUBLISH'
          ? await this.db.postExecution.findUnique({
              where: { postId: job.targetId },
            })
          : null;
      if (job.kind === 'PUBLISH' && !phase) {
        await this.jobs.rejectBeforePublish(job);
        await this.db.post.updateMany({
          where: {
            id: job.targetId,
            organizationId: job.organizationId,
            state: 'QUEUE',
          },
          data: {
            state: 'ERROR',
            error:
              'Publishing did not start. Check the channel, approval and media, then reschedule.',
          },
        });
        return;
      }
      if (phase?.phase === 'PENDING' && phase.readErrors < 4) {
        await this.db.$transaction(async (tx) => {
          const retry = await tx.internalJob.updateMany({
            where: {
              id: job.id,
              state: 'RUNNING',
              leaseToken: job.leaseToken,
              leaseExpiresAt: { gt: new Date() },
            },
            data: {
              state: 'QUEUED',
              runAt: new Date(Date.now() + 30_000),
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          if (retry.count)
            await tx.postExecution.update({
              where: { postId: job.targetId },
              data: { readErrors: { increment: 1 } },
            });
        });
        return;
      }
      await this.jobs.fail(job);
      if (job.kind === 'PUBLISH') {
        if (error instanceof PublishedWithError) {
          await this.posts.updateResolvedRelease(
            error.postDbId,
            job.organizationId,
            error.releaseId,
            error.releaseURL
          );
        }
        await this.db.post.updateMany({
          where: {
            id: job.targetId,
            organizationId: job.organizationId,
            state: 'QUEUE',
          },
          data: {
            state: 'ERROR',
            error:
              'Publish outcome unconfirmed. Check the platform before reposting.',
          },
        });
        try {
          await this.notifications.inAppNotification(
            job.organizationId,
            'Post needs review',
            'A publishing attempt could not be confirmed. Check the account before creating a replacement post.'
          );
        } catch {}
      }
      this.logger.warn(`${job.kind} job ${job.id} requires recovery or retry.`);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
  }

  private async refreshChannel(
    job: InternalJob,
    assertLease: () => Promise<void>
  ) {
    const channel = await this.db.integration.findFirst({
      where: {
        id: job.targetId,
        organizationId: job.organizationId,
        deletedAt: null,
        disabled: false,
        refreshNeeded: false,
        inBetweenSteps: false,
      },
    });
    if (!channel) {
      await this.jobs.finish(job);
      return;
    }
    if (
      channel.tokenExpiration &&
      channel.tokenExpiration.getTime() > Date.now() + 3600_000
    ) {
      await this.jobs.finish(job);
      return;
    }
    await assertLease();
    const refreshed = await this.refresh.refresh(channel);
    if (!refreshed) throw new Error('Channel needs reconnection');
    await assertLease();
    await this.jobs.finish(job);
    // The sweep schedules the next persisted expiration; reconnects can update it.
  }

  private async collectAnalytics(
    job: InternalJob,
    assertLease: () => Promise<void>
  ) {
    const post = await this.db.post.findFirst({
      where: {
        id: job.targetId,
        organizationId: job.organizationId,
        state: 'PUBLISHED',
        deletedAt: null,
      },
      include: { integration: true },
    });
    if (
      !post ||
      !post.releaseId ||
      post.releaseId === 'missing' ||
      post.integration.disabled ||
      post.integration.deletedAt
    ) {
      await this.jobs.finish(job);
      return;
    }
    await assertLease();
    const data = await this.insights.collect(
      job.organizationId,
      job.targetId,
      90
    );
    if (!data.metrics.length || data.metrics.every((m) => m.value === null))
      throw new Error('No analytics returned');
    await assertLease();
    await this.jobs.finish(job);
  }

  private async publish(job: InternalJob, assertLease: () => Promise<void>) {
    const post = await this.db.post.findFirst({
      where: { id: job.targetId, organizationId: job.organizationId },
      include: { integration: true },
    });
    if (!post || post.deletedAt || post.state !== 'QUEUE') {
      await this.jobs.cancelClaim(job);
      return;
    }
    if (post.intervalInDays)
      throw new Error('Repeat posting is not enabled in this runtime');
    if (post.submittedForOrderId && post.approvedSubmitForOrder !== 'YES')
      throw new Error('Post is awaiting approval');
    let channel = post.integration;
    if (
      !channel ||
      channel.organizationId !== job.organizationId ||
      channel.disabled ||
      channel.deletedAt ||
      channel.refreshNeeded ||
      channel.inBetweenSteps
    )
      throw new Error('Channel unavailable');
    const provider = this.integrations.getSocialIntegration(
      channel.providerIdentifier
    );
    if (!provider) throw new Error('Unknown provider');
    if (channel.tokenExpiration && channel.tokenExpiration <= new Date()) {
      if (!(await this.refresh.refresh(channel)))
        throw new Error('Reconnect channel');
      if (provider.refreshWait) await timer(10_000);
      channel = await this.db.integration.findUniqueOrThrow({
        where: { id: channel.id },
      });
    }
    const execution = await this.db.postExecution.findUnique({
      where: { postId: post.id },
    });
    if (execution?.phase === 'MUTATING')
      throw new Error('An earlier publishing mutation has an unknown result');
    if (execution?.phase === 'PENDING') {
      await assertLease();
      const checked = await provider.checkPostStatus(
        channel.token,
        execution.pendingData,
        channel
      );
      if (checked.status === 'completed') {
        await this.completePost(
          job,
          checked.postId,
          checked.releaseURL,
          assertLease
        );
        return;
      }
      if (execution.checks >= 90)
        throw new Error('Platform processing exceeded the status-check budget');
      // Persist provider cursor BEFORE a mutation. A restart only checks status;
      // it never replays an uncertain finalize request automatically.
      if (checked.status === 'ready') {
        await assertLease();
        await this.db.postExecution.update({
          where: { postId: post.id },
          data: { phase: 'MUTATING', pendingData: checked.pendingData },
        });
        await assertLease();
        const finalized = await provider.finalizePost(
          channel.token,
          checked.pendingData,
          channel
        );
        if (finalized.status === 'completed') {
          await this.completePost(
            job,
            finalized.postId,
            finalized.releaseURL,
            assertLease
          );
          return;
        }
        await this.deferPending(job, finalized.pendingData, assertLease);
      } else await this.deferPending(job, checked.pendingData, assertLease);
      return;
    }

    // Mapping/media preparation is reusable Postiz behavior; platform-specific
    // code stays in the provider. Every outbound publishing mutation is fenced.
    const tagged = await this.posts.updateTags(job.organizationId, [post]);
    const message = tagged[0];
    const details = [
      {
        id: post.id,
        message: stripHtmlValidation(
          provider.editor,
          message.content,
          true,
          false,
          !/<\/?[a-z][\s\S]*>/i.test(message.content),
          provider.mentionFormat,
          !!provider.inlineImages?.(JSON.parse(message.settings || '{}'))
        ),
        settings: JSON.parse(message.settings || '{}'),
        media: await this.posts.updateMedia(
          post.id,
          JSON.parse(post.image || '[]'),
          !!provider.convertToJPEG
        ),
      },
    ];
    await assertLease();
    let result;
    if (post.parentPostId) {
      if (!provider.comment)
        throw new Error('Provider does not support comments');
      const parent = await this.db.post.findFirstOrThrow({
        where: {
          id: post.parentPostId,
          organizationId: job.organizationId,
          state: 'PUBLISHED',
          deletedAt: null,
        },
      });
      let root = parent;
      while (root.parentPostId)
        root = await this.db.post.findFirstOrThrow({
          where: {
            id: root.parentPostId,
            organizationId: job.organizationId,
            state: 'PUBLISHED',
            deletedAt: null,
          },
        });
      await this.db.postExecution.upsert({
        where: { postId: post.id },
        create: { postId: post.id, phase: 'MUTATING' },
        update: { phase: 'MUTATING' },
      });
      await assertLease();
      result = await provider.comment(
        channel.internalId,
        root.releaseId,
        root.id === parent.id ? undefined : parent.releaseId,
        channel.token,
        details,
        channel
      );
    } else {
      await this.db.postExecution.upsert({
        where: { postId: post.id },
        create: { postId: post.id, phase: 'MUTATING' },
        update: { phase: 'MUTATING' },
      });
      await assertLease();
      result = provider.postPending
        ? await provider.postPending(
            channel.internalId,
            channel.token,
            details,
            channel
          )
        : await provider.post(
            channel.internalId,
            channel.token,
            details,
            channel
          );
    }
    const published = result?.find((r) => r.id === post.id) || result?.[0];
    if (!published) throw new Error('No publishing result');
    if (published.status === 'pending') {
      await this.deferPending(job, published.pendingData, assertLease);
      return;
    }
    if (!published.postId) throw new Error('No platform post ID');
    await this.completePost(
      job,
      published.postId,
      published.releaseURL,
      assertLease
    );
  }

  private async deferPending(
    job: InternalJob,
    pendingData: any,
    assertLease: () => Promise<void>
  ) {
    await assertLease();
    await this.db.$transaction(async (tx) => {
      const updated = await tx.internalJob.updateMany({
        where: {
          id: job.id,
          state: 'RUNNING',
          leaseToken: job.leaseToken,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          state: 'QUEUED',
          leaseToken: null,
          leaseExpiresAt: null,
          runAt: new Date(Date.now() + 20_000),
        },
      });
      if (!updated.count) throw new Error('Lease lost');
      await tx.postExecution.upsert({
        where: { postId: job.targetId },
        create: {
          postId: job.targetId,
          phase: 'PENDING',
          pendingData,
          checks: 1,
        },
        update: {
          phase: 'PENDING',
          pendingData,
          checks: { increment: 1 },
          readErrors: 0,
        },
      });
    });
  }

  private async completePost(
    job: InternalJob,
    releaseId: string,
    releaseURL: string,
    assertLease: () => Promise<void>
  ) {
    await assertLease();
    await this.db.$transaction(async (tx) => {
      const completed = await tx.internalJob.updateMany({
        where: {
          id: job.id,
          state: 'RUNNING',
          leaseToken: job.leaseToken,
          leaseExpiresAt: { gt: new Date() },
        },
        data: { state: 'COMPLETED', leaseToken: null, leaseExpiresAt: null },
      });
      if (!completed.count) throw new Error('Lease lost');
      const post = await tx.post.update({
        where: { id: job.targetId, organizationId: job.organizationId },
        data: { state: 'PUBLISHED', releaseId, releaseURL, error: null },
      });
      await tx.postExecution.upsert({
        where: { postId: post.id },
        create: { postId: post.id, phase: 'COMPLETED' },
        update: { phase: 'COMPLETED', pendingData: Prisma.DbNull },
      });
      const child = await tx.post.findFirst({
        where: {
          parentPostId: post.id,
          organizationId: job.organizationId,
          deletedAt: null,
          state: 'QUEUE',
        },
      });
      if (child) {
        const key = {
          organizationId: job.organizationId,
          kind: 'PUBLISH' as const,
          targetId: child.id,
        };
        await tx.internalJob.upsert({
          where: { organizationId_kind_targetId: key },
          create: {
            ...key,
            runAt: new Date(Date.now() + Math.max(0, child.delay) * 60_000),
          },
          update: {},
        });
      }
    });
    // A notification failure must never re-run the publish.
    try {
      await this.notifications.inAppNotification(
        job.organizationId,
        'Post published',
        `Your post has been published: ${releaseURL}`
      );
    } catch {}
    // Preserve Postiz's existing best-effort publish webhooks. These run after
    // the durable result, so a delivery failure cannot repeat the platform post.
    try {
      const post = await this.db.post.findUniqueOrThrow({
        where: { id: job.targetId },
        select: { integrationId: true },
      });
      const hooks = (
        await this.webhooks.getWebhooks(job.organizationId)
      ).filter(
        (hook) =>
          !hook.integrations.length ||
          hook.integrations.some((i) => i.integration.id === post.integrationId)
      );
      if (hooks.length) {
        const body = await this.posts.getPostByForWebhookId(
          job.targetId,
          post.integrationId
        );
        await Promise.allSettled(
          hooks.map((hook) =>
            fetch(hook.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(30_000),
              // @ts-ignore — undici's dispatcher is absent from lib.dom's fetch type.
              dispatcher: getSsrfSafeDispatcher(),
            })
          )
        );
      }
    } catch {}
  }
}
