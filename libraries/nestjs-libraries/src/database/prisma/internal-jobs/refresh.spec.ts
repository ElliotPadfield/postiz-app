import 'reflect-metadata';
import { RefreshIntegrationService } from '../../../integrations/refresh.integration.service';
import { stateStore } from '../../../state/postgres.state';

jest.mock('../../../integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('../integrations/integration.service', () => ({
  IntegrationService: class {},
}));

const url = process.env.POSTIZ_QUEUE_TEST_DATABASE_URL;
if (
  !url ||
  url !== process.env.DATABASE_URL ||
  new URL(url).hostname !== '127.0.0.1' ||
  new URL(url).pathname !== '/postiz_queue_test'
)
  throw new Error('Use pnpm test:internal-jobs');

it('shares one token renewal between the publisher and analytics collector', async () => {
  let current: any = {
    id: 'refresh-concurrency',
    internalId: 'account',
    organizationId: 'org',
    name: 'Account',
    providerIdentifier: 'mock',
    token: 'old',
    refreshToken: 'refresh',
    tokenExpiration: new Date(0),
  };
  await stateStore.del('refreshLock:refresh-concurrency');
  const refreshToken = jest.fn(async () => ({
    id: 'account',
    name: 'Account',
    username: 'account',
    accessToken: 'new',
    refreshToken: 'new-refresh',
    expiresIn: 3600,
  }));
  const channels = {
    getIntegrationById: async () => current,
    createOrUpdateIntegration: async () => {
      current = {
        ...current,
        token: 'new',
        tokenExpiration: new Date(Date.now() + 3600_000),
      };
    },
  };
  const service = new RefreshIntegrationService(
    { getSocialIntegration: () => ({ refreshToken }) } as any,
    channels as any,
    {} as any
  );
  const staleSnapshot = { ...current };
  const [one, two] = await Promise.all([
    service.refresh(current),
    service.refresh(current),
  ]);
  expect(refreshToken).toHaveBeenCalledTimes(1);
  expect(one && one.accessToken).toBe('new');
  expect(two && two.accessToken).toBe('new');
  const afterRelease = await service.refresh(staleSnapshot);
  expect(afterRelease && afterRelease.accessToken).toBe('new');
  expect(refreshToken).toHaveBeenCalledTimes(1);
  expect(await stateStore.get('refreshLock:refresh-concurrency')).toBeNull();
});

afterAll(async () => {
  await stateStore.client.$disconnect();
});
