import 'reflect-metadata';
import { InstagramProvider } from '../../../integrations/social/instagram.provider';
import { YoutubeProvider } from '../../../integrations/social/youtube.provider';
import { RefreshToken } from '../../../integrations/social.abstract';
import { WalletProvider } from '@gitroom/backend/services/auth/providers/wallet.provider';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { stateStore } from '../../../state/postgres.state';
import { google } from 'googleapis';

jest.mock('../../../integrations/social.abstract', () => ({
  SocialAbstract: class {},
  RefreshToken: class extends Error {},
  BadBody: class extends Error {},
  PublishedWithError: class extends Error {},
  stripQuery: (s: string) => s,
}));
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn(() => ({ setCredentials: jest.fn() })) },
    youtubeAnalytics: jest.fn(),
  },
}));

describe('Additional provider insights', () => {
  afterEach(() => jest.restoreAllMocks());

  it('collects Instagram watch time/skip rate and derives rates with an explicit denominator', async () => {
    const values = {
      views: 1000,
      reach: 800,
      likes: 70,
      comments: 3,
      shares: 12,
      saved: 8,
      ig_reels_avg_watch_time: 12500,
      ig_reels_video_view_total_time: 12500000,
      reels_skip_rate: 34.5,
    };
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input, init) => {
        const key = new URL(String(input)).searchParams.get('metric')!;
        expect(String(input)).not.toContain('TEST_ONLY_TOKEN');
        expect((init?.headers as any).Authorization).toBe(
          'Bearer TEST_ONLY_TOKEN'
        );
        return new Response(
          JSON.stringify({
            data: key
              .split(',')
              .map((name) => ({ name, values: [{ value: values[name] }] })),
          }),
          { status: 200 }
        );
      });
    const insights = await new InstagramProvider().postInsights(
      'account',
      'TEST_ONLY_TOKEN___user',
      'media',
      30
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(
      insights.metrics.find((m) => m.key === 'ig_reels_avg_watch_time')
    ).toMatchObject({ value: 12500, unit: 'milliseconds' });
    expect(
      insights.metrics.find((m) => m.key === 'reels_skip_rate')?.value
    ).toBe(34.5);
    expect(
      insights.metrics.find((m) => m.key === 'likes_per_100_views')?.value
    ).toBeCloseTo(7);
    expect(insights.retention).toEqual([]);
  });

  it('keeps available Instagram counts when a Reel-only metric is unavailable', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const key = new URL(String(input)).searchParams.get('metric')!;
      return key === 'views'
        ? new Response(
            JSON.stringify({
              data: [{ name: 'views', values: [{ value: 0 }] }],
            })
          )
        : new Response(JSON.stringify({ error: { code: 100 } }), {
            status: 400,
          });
    });
    const data = await new InstagramProvider().postInsights(
      'account',
      'token',
      'image',
      30
    );
    expect(data.metrics.find((m) => m.key === 'views')?.value).toBe(0);
    expect(
      data.metrics.find((m) => m.key === 'reels_skip_rate')?.value
    ).toBeNull();
    expect(
      data.metrics.find((m) => m.key === 'likes_per_100_views')?.value
    ).toBeNull();
  });

  it('signals expired Instagram authorization instead of saving zero-valued insights', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 })
      );
    await expect(
      new InstagramProvider().postInsights('account', 'token', 'media', 30)
    ).rejects.toBeInstanceOf(RefreshToken);
  });

  it('uses YouTube Analytics reports for watch time and preserves retention above 100%', async () => {
    const query = jest.fn(async (params) => {
      expect(params.ids).toBe('channel==UC-test');
      expect(params.filters).toBe('video==video-test');
      if (params.dimensions)
        return {
          data: {
            columnHeaders: [
              { name: 'elapsedVideoTimeRatio' },
              { name: 'audienceWatchRatio' },
              { name: 'relativeRetentionPerformance' },
            ],
            rows: [
              [0.1, 1.2, 0.8],
              [0.9, 0.4, 0.6],
            ],
          },
        };
      if (params.metrics === 'engagedViews')
        throw { response: { status: 403 } };
      return {
        data: {
          rows: [
            [
              params.metrics === 'views'
                ? 1000
                : params.metrics === 'likes'
                ? 50
                : 12,
            ],
          ],
        },
      };
    });
    (google.youtubeAnalytics as jest.Mock).mockReturnValue({
      reports: { query },
    });
    const data = await new YoutubeProvider().postInsights(
      'UC-test',
      'token',
      'video-test',
      90
    );
    expect(
      data.metrics.find((m) => m.key === 'averageViewDuration')
    ).toMatchObject({ unit: 'seconds', value: 12 });
    expect(
      data.metrics.find((m) => m.key === 'engagedViews')?.value
    ).toBeNull();
    expect(
      data.metrics.find((m) => m.key === 'likes_per_100_views')?.value
    ).toBe(5);
    expect(data.retention[0]).toEqual({
      elapsedRatio: 0.1,
      audienceWatchRatio: 1.2,
      relativePerformance: 0.8,
    });
    expect(query).toHaveBeenCalledTimes(10);
  });
});

describe('Wallet OAuth state after Redis removal', () => {
  afterAll(async () => {
    await stateStore.client.$disconnect();
  });
  it('consumes the signed challenge once while retaining the login-registration token flow', async () => {
    process.env.JWT_SECRET = 'disposable-wallet-test-secret';
    const wallet = new WalletProvider();
    const pair = nacl.sign.keyPair();
    const publicKey = bs58.encode(pair.publicKey);
    const challenge = await wallet.generateLink({ publicKey });
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(challenge), pair.secretKey)
    ).toString('hex');
    const code = Buffer.from(
      JSON.stringify({ publicKey, challenge, signature })
    ).toString('base64');
    const token = await wallet.getToken(code);
    expect(token).not.toBe('');
    expect((await wallet.getUser(token)).id).toBe(`wallet_${publicKey}`);
    expect((await wallet.getUser(token)).id).toBe(`wallet_${publicKey}`);
    expect(await wallet.getToken(code)).toBe('');
  });
});
