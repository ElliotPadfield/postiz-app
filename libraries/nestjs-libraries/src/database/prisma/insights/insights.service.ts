import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PostsService } from '../posts/posts.service';
import { IntegrationManager } from '../../../integrations/integration.manager';
import { RefreshIntegrationService } from '../../../integrations/refresh.integration.service';
import { RefreshToken } from '../../../integrations/social.abstract';
import { PostInsights } from '../../../integrations/social/social.integrations.interface';
import { InsightsRepository } from './insights.repository';
import { IntegrationService } from '../integrations/integration.service';

@Injectable()
export class InsightsService {
  constructor(
    private posts: PostsService,
    private providers: IntegrationManager,
    private refresh: RefreshIntegrationService,
    private snapshots: InsightsRepository,
    private channels: IntegrationService
  ) {}

  async importPublished(
    organizationId: string,
    integrationId: string,
    limit: number,
    forceRefresh = false
  ): Promise<{ added: number; existing: number; scanned: number }> {
    const channel = await this.channels.getIntegrationById(
      organizationId,
      integrationId
    );
    if (!channel || channel.deletedAt)
      throw new NotFoundException('Channel not found');
    if (channel.disabled || channel.refreshNeeded)
      throw new BadRequestException(
        'Enable or reconnect the channel before importing'
      );
    const provider = this.providers.getSocialIntegration(
      channel.providerIdentifier
    );
    if (!provider?.listPublishedPosts)
      throw new BadRequestException(
        'Published-post import is not available for this platform'
      );
    if (
      forceRefresh ||
      (channel.tokenExpiration && channel.tokenExpiration <= new Date())
    ) {
      const token = await this.refresh.refresh(channel);
      if (!token)
        throw new BadRequestException('Reconnect the channel before importing');
      channel.token = token.accessToken;
    }
    try {
      const posts = await provider.listPublishedPosts(
        channel.internalId,
        channel.token,
        limit
      );
      return this.snapshots.importPublished(
        organizationId,
        integrationId,
        provider.identifier,
        posts
      );
    } catch (error) {
      if (error instanceof RefreshToken && !forceRefresh)
        return this.importPublished(organizationId, integrationId, limit, true);
      throw error;
    }
  }

  async collect(
    organizationId: string,
    postId: string,
    days: number,
    forceRefresh = false
  ): Promise<PostInsights & { collectedAt?: Date }> {
    const post = await this.posts.getPostById(postId, organizationId);
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');
    const channel = post.integration;
    if (channel.disabled || channel.deletedAt || channel.refreshNeeded)
      return {
        metrics: [],
        retention: [],
        retentionUnavailable:
          'Reconnect or enable the channel to collect insights.',
      };
    if (!post.releaseId || post.releaseId === 'missing')
      return {
        metrics: [],
        retention: [],
        retentionUnavailable:
          'Connect the published platform post before collecting insights.',
      };
    const provider = this.providers.getSocialIntegration(
      channel.providerIdentifier
    );
    if (!provider.postInsights)
      return {
        metrics: [],
        retention: [],
        retentionUnavailable:
          'Additional watch-time insights are not available for this platform. Basic statistics remain available above.',
      };
    if (
      forceRefresh ||
      (channel.tokenExpiration && channel.tokenExpiration <= new Date())
    ) {
      const tokens = await this.refresh.refresh(channel);
      if (!tokens)
        return {
          metrics: [],
          retention: [],
          retentionUnavailable: 'Reconnect this channel to collect insights.',
        };
      channel.token = tokens.accessToken;
    }
    if (!forceRefresh) {
      const cached = (await this.snapshots.latest(organizationId, postId)).find(
        (snapshot) => {
          const saved = snapshot.data as unknown as PostInsights;
          return (
            snapshot.collectedAt.getTime() > Date.now() - 10 * 60_000 &&
            (!saved.startDate ||
              saved.startDate ===
                new Date(Date.now() - days * 86400_000)
                  .toISOString()
                  .slice(0, 10))
          );
        }
      );
      if (cached)
        return {
          ...(cached.data as unknown as PostInsights),
          collectedAt: cached.collectedAt,
        };
    }
    try {
      const resolved = await this.posts.resolveRelease(organizationId, post);
      const data = await provider.postInsights(
        channel.internalId,
        channel.token,
        resolved.releaseId,
        days
      );
      // Store collection time separately from a video's report window. Nulls
      // represent unavailable metrics and are never coerced into zero views.
      const saved = await this.snapshots.save(
        organizationId,
        postId,
        channel.providerIdentifier,
        data
      );
      return { ...data, collectedAt: saved.collectedAt };
    } catch (error) {
      if (error instanceof RefreshToken && !forceRefresh)
        return this.collect(organizationId, postId, days, true);
      throw error;
    }
  }

  async history(organizationId: string, postId: string) {
    const post = await this.posts.getPostById(postId, organizationId);
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');
    return this.snapshots.latest(organizationId, postId);
  }
}
