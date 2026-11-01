import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaRepository, PrismaService } from '../prisma.service';
import {
  PostInsights,
  PublishedPost,
} from '../../../integrations/social/social.integrations.interface';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { escape } from 'lodash';

@Injectable()
export class InsightsRepository {
  constructor(
    private snapshots: PrismaRepository<'metricSnapshot'>,
    private db: PrismaService
  ) {}

  importPublished(
    organizationId: string,
    integrationId: string,
    provider: string,
    posts: PublishedPost[]
  ) {
    return this.db.$transaction(
      async (tx) => {
        // Fence a publisher while importing; do not duplicate an in-flight or
        // uncertain platform result whose native Post row is not resolved yet.
        const channelPosts = await tx.post.findMany({
          where: { integrationId, organizationId },
          select: { id: true },
        });
        const targets = channelPosts.map((post) => post.id);
        await tx.internalJob.updateMany({
          where: { organizationId, targetId: { in: targets }, kind: 'PUBLISH' },
          data: { version: { increment: 1 } },
        });
        const unresolvedJob = await tx.internalJob.count({
          where: {
            organizationId,
            targetId: { in: targets },
            kind: 'PUBLISH',
            state: { in: ['RUNNING', 'REVIEW'] },
          },
        });
        const unresolvedUpload = await tx.postExecution.count({
          where: {
            postId: { in: targets },
            phase: { in: ['PENDING', 'MUTATING'] },
          },
        });
        if (unresolvedJob || unresolvedUpload)
          throw new ConflictException(
            'Finish or review active publishing before importing this channel'
          );
        let added = 0;
        for (const post of posts) {
          const existing = await tx.post.findFirst({
            where: { organizationId, integrationId, releaseId: post.id },
            select: { id: true },
          });
          if (existing) continue;
          const id =
            'import_' +
            createHash('sha256')
              .update(`${organizationId}\0${integrationId}\0${post.id}`)
              .digest('hex')
              .slice(0, 32);
          await tx.post.upsert({
            where: { id },
            create: {
              id,
              organizationId,
              integrationId,
              state: 'PUBLISHED',
              publishDate: new Date(post.publishedAt),
              group: id,
              content: escape(post.content).replace(/\n/g, '<br />'),
              releaseId: post.id,
              releaseURL: post.url,
              image: '[]',
              settings: JSON.stringify({ __type: provider }),
              creationMethod: 'API',
            },
            update: {},
          });
          added++;
        }
        return { added, existing: posts.length - added, scanned: posts.length };
      },
      { timeout: 15000 }
    );
  }

  save(
    organizationId: string,
    postId: string,
    provider: string,
    data: PostInsights
  ) {
    return this.snapshots.model.metricSnapshot.create({
      data: {
        organizationId,
        postId,
        provider,
        data: data as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, collectedAt: true },
    });
  }

  latest(organizationId: string, postId: string) {
    return this.snapshots.model.metricSnapshot.findMany({
      where: { organizationId, postId },
      orderBy: { collectedAt: 'desc' },
      take: 100,
      select: { collectedAt: true, data: true },
    });
  }
}
