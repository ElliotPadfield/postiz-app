import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { ApiTags } from '@nestjs/swagger';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { InsightsService } from '@gitroom/nestjs-libraries/database/prisma/insights/insights.service';
import { PostInsightsQueryDto } from '@gitroom/nestjs-libraries/dtos/analytics/post.insights.dto';
import { ImportPublishedDto } from '@gitroom/nestjs-libraries/dtos/analytics/import.published.dto';

@ApiTags('Analytics')
@Controller('/analytics')
export class AnalyticsController {
  constructor(
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _insights: InsightsService
  ) {}

  @Get('/:integration')
  async getIntegration(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') integration: string,
    @Query('date') date: string
  ) {
    return this._integrationService.checkAnalytics(org, integration, date);
  }

  @Post('/import/:integration')
  importPublished(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') integration: string,
    @Body() body: ImportPublishedDto
  ) {
    return this._insights.importPublished(org.id, integration, body.limit);
  }

  @Get('/post/:postId')
  async getPostAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string,
    @Query('date') date: string
  ) {
    return this._postsService.checkPostAnalytics(org.id, postId, +date);
  }

  @Get('/post/:postId/insights')
  getPostInsights(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string,
    @Query() query: PostInsightsQueryDto
  ) {
    return this._insights.collect(org.id, postId, query.days);
  }

  @Get('/post/:postId/insights/history')
  getPostInsightsHistory(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string
  ) {
    return this._insights.history(org.id, postId);
  }
}
