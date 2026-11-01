import {
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Integration } from '@prisma/client';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import {
  AuthTokenDetails,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { InternalJobsService } from '../database/prisma/internal-jobs/internal.jobs.service';
import { stateStore } from '../state/postgres.state';
import { randomUUID } from 'node:crypto';
import { timer } from '@gitroom/helpers/utils/timer';

@Injectable()
export class RefreshIntegrationService {
  constructor(
    private _integrationManager: IntegrationManager,
    @Inject(forwardRef(() => IntegrationService))
    private _integrationService: IntegrationService,
    private _jobs: InternalJobsService
  ) {}
  async refresh(
    integration: Integration,
    cause = ''
  ): Promise<false | AuthTokenDetails> {
    const lockKey = `refreshLock:${integration.id}`;
    const owner = randomUUID();
    if (!(await stateStore.set(lockKey, owner, 'EX', 600, 'NX'))) {
      for (let attempt = 0; attempt < 30; attempt++) {
        await timer(1000);
        const latest = await this._integrationService.getIntegrationById(
          integration.organizationId,
          integration.id
        );
        if (!latest || latest.refreshNeeded || latest.deletedAt) return false;
        if (this.tokenAdvanced(integration, latest))
          return this.currentTokenDetails(latest);
        if (!(await stateStore.get(lockKey)))
          return this.refresh(latest, cause);
      }
      throw new Error('Channel renewal is already in progress');
    }
    try {
      // The caller may have read its row before a previous lock owner renewed
      // it, even if this call acquires without contention. Never rotate a stale
      // refresh token after winning the lock.
      const latest = await this._integrationService.getIntegrationById(
        integration.organizationId,
        integration.id
      );
      if (!latest || latest.refreshNeeded || latest.deletedAt) return false;
      if (this.tokenAdvanced(integration, latest))
        return this.currentTokenDetails(latest);
      return await this.refreshExclusive(latest, cause);
    } finally {
      await stateStore.delIfValue(lockKey, owner);
    }
  }

  private tokenAdvanced(previous: Integration, current: Integration) {
    return (
      current.token !== previous.token ||
      current.refreshToken !== previous.refreshToken ||
      (current.tokenExpiration &&
        current.tokenExpiration.getTime() >
          (previous.tokenExpiration?.getTime() || 0))
    );
  }

  private currentTokenDetails(channel: Integration): AuthTokenDetails {
    return {
      id: channel.internalId,
      name: channel.name,
      username: channel.name,
      accessToken: channel.token,
      refreshToken: channel.refreshToken,
      expiresIn: channel.tokenExpiration
        ? Math.max(
            0,
            Math.floor((channel.tokenExpiration.getTime() - Date.now()) / 1000)
          )
        : undefined,
    };
  }

  private async refreshExclusive(
    integration: Integration,
    cause: string
  ): Promise<false | AuthTokenDetails> {
    const socialProvider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    const refresh = await this.refreshProcess(
      integration,
      socialProvider,
      cause
    );

    if (!refresh) {
      return false as const;
    }

    await this._integrationService.createOrUpdateIntegration(
      undefined,
      !!socialProvider.oneTimeToken,
      integration.organizationId,
      integration.name,
      integration.picture!,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      refresh.accessToken,
      refresh.refreshToken,
      refresh.expiresIn
    );

    return refresh;
  }

  public async setBetweenSteps(integration: Integration, cause = '') {
    await this._integrationService.setBetweenRefreshSteps(integration.id);
    await this._integrationService.informAboutRefreshError(
      integration.organizationId,
      integration,
      cause
    );
  }

  public async startRefreshWorkflow(
    orgId: string,
    id: string,
    integration: SocialProvider
  ) {
    if (!integration.refreshCron) {
      return false;
    }

    const channel = await this._integrationService.getIntegrationById(
      orgId,
      id
    );
    if (!channel?.tokenExpiration || channel.deletedAt || channel.refreshNeeded)
      return false;
    // Renewal is collected by the worker sweep as well, so a concurrent running
    // refresh must not turn a successful OAuth reconnect into an error.
    try {
      return await this._jobs.schedule(
        orgId,
        id,
        'REFRESH',
        new Date(
          Math.max(
            Date.now(),
            new Date(channel.tokenExpiration).getTime() - 3600_000
          )
        )
      );
    } catch (error) {
      if (error instanceof ConflictException) return false;
      throw error;
    }
  }

  private async refreshProcess(
    integration: Integration,
    socialProvider: SocialProvider,
    cause = ''
  ): Promise<AuthTokenDetails | false> {
    let refreshError: any = undefined;
    const refresh: false | AuthTokenDetails = await socialProvider
      .refreshToken(integration.refreshToken)
      .catch((err) => {
        refreshError = err;
        return false as const;
      });

    if (!refresh || !refresh.accessToken) {
      console.error(
        `Could not refresh ${integration.providerIdentifier} integration ${integration.id}`,
        refreshError?.response?.data ||
          refreshError?.message ||
          refreshError ||
          'no access token returned'
      );

      // informAboutRefreshError (with the failure cause) already notifies
      // the user, and refreshNeeded sets the same flag disconnectChannel
      // would — calling disconnectChannel here sent a second, cause-less
      // copy of the same email for every failed refresh.
      // A channel that is already flagged keeps failing on every later
      // refresh attempt (e.g. hourly analytics polling of an expired token),
      // so only the attempt that flagged it notifies.
      const flagged = await this._integrationService.refreshNeeded(
        integration.organizationId,
        integration.id
      );

      if (flagged) {
        await this._integrationService.informAboutRefreshError(
          integration.organizationId,
          integration,
          socialProvider.refreshErrorMessage?.(refreshError) || cause
        );
      }

      return false;
    }

    if (
      !socialProvider.reConnect ||
      integration.rootInternalId === integration.internalId
    ) {
      return refresh;
    }

    let reConnect;
    try {
      reConnect = await socialProvider.reConnect(
        integration.rootInternalId,
        integration.internalId,
        refresh.accessToken
      );
    } catch (err: any) {
      console.error(
        `Could not reconnect ${integration.providerIdentifier} integration ${integration.id} after a successful token refresh`,
        err?.response?.data || err?.message || err
      );
      throw err;
    }

    return {
      ...refresh,
      ...reConnect,
    };
  }
}
