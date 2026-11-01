import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../prisma.service';
import { PostInsights } from '../../../integrations/social/social.integrations.interface';
import { Prisma } from '@prisma/client';

@Injectable()
export class InsightsRepository {
  constructor(private snapshots: PrismaRepository<'metricSnapshot'>) {}

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
