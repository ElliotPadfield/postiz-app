import 'reflect-metadata';
import { InstagramProvider } from '../../../integrations/social/instagram.provider';
import { LinkedinProvider } from '../../../integrations/social/linkedin.provider';
import { YoutubeProvider } from '../../../integrations/social/youtube.provider';
import { RefreshToken } from '../../../integrations/social.abstract';
import { WalletProvider } from '@gitroom/backend/services/auth/providers/wallet.provider';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { stateStore } from '../../../state/postgres.state';
import { google } from 'googleapis';

jest.mock('../../../integrations/social.abstract', () => ({
  SocialAbstract: class {
    checkScopes(required: string[], got: string | string[]) {
      const granted = Array.isArray(got) ? got : got.split(' ');
      if (!required.every((scope) => granted.includes(scope)))
        throw new Error('Missing granted scopes');
    }
  },
  RefreshToken: class extends Error {},
  BadBody: class extends Error {},
  PublishedWithError: class extends Error {},
  stripQuery: (s: string) => s,
}));
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn(() => ({ setCredentials: jest.fn() })) },
    youtubeAnalytics: jest.fn(),
    youtube: jest.fn(),
  },
}));

describe('Additional provider insights', () => {
  afterEach(() => jest.restoreAllMocks());

  it('imports numeric Instagram media IDs across pages without following token-bearing next URLs', async () => {
    const read = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.hostname).toBe('graph.facebook.com');
        expect(url.pathname).toMatch(/\/owned-account\/media$/);
        expect(url.searchParams.has('access_token')).toBe(false);
        expect((init?.headers as any).Authorization).toBe(
          'Bearer TEST_ONLY_TOKEN'
        );
        const second = url.searchParams.get('after') === 'cursor';
        return new Response(
          JSON.stringify({
            data: [
              {
                id: second ? '178002' : '178001',
                permalink: 'https://www.instagram.com/reel/test/',
                timestamp: '2026-10-01T12:00:00Z',
                caption: 'Caption',
              },
            ],
            paging: second
              ? {}
              : {
                  next: 'https://malicious.invalid/?access_token=secret',
                  cursors: { after: 'cursor' },
                },
          })
        );
      });
    const posts = await new InstagramProvider().listPublishedPosts(
      'owned-account',
      'TEST_ONLY_TOKEN___user',
      2
    );
    expect(posts.map((post) => post.id)).toEqual(['178001', '178002']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('imports videos only from the connected YouTube channel uploads playlist', async () => {
    const channels = jest.fn(async () => ({
      data: {
        items: [
          { contentDetails: { relatedPlaylists: { uploads: 'UU-owned' } } },
        ],
      },
    }));
    const playlist = jest.fn(async () => ({
      data: {
        items: [
          {
            contentDetails: {
              videoId: 'video-owned',
              videoPublishedAt: '2026-10-01T12:00:00Z',
            },
            snippet: { title: 'Title', description: 'Description' },
          },
        ],
      },
    }));
    (google.youtube as jest.Mock).mockReturnValue({
      channels: { list: channels },
      playlistItems: { list: playlist },
      videos: {
        list: jest.fn(async () => ({
          data: {
            items: [
              {
                id: 'video-owned',
                snippet: {
                  title: 'Title',
                  publishedAt: '2026-10-01T12:00:00Z',
                },
                status: { privacyStatus: 'public', uploadStatus: 'processed' },
              },
              {
                id: 'private',
                snippet: { publishedAt: '2026-10-01T12:00:00Z' },
                status: { privacyStatus: 'private', uploadStatus: 'processed' },
              },
              {
                id: 'scheduled',
                snippet: { publishedAt: '2099-01-01T00:00:00Z' },
                status: { privacyStatus: 'public', uploadStatus: 'processed' },
              },
              { id: 'deleted', status: { uploadStatus: 'deleted' } },
            ],
          },
        })),
      },
    });
    const posts = await new YoutubeProvider().listPublishedPosts(
      'UC-owned',
      'TEST_ONLY_TOKEN',
      100
    );
    expect(channels.mock.calls[0][0]).toMatchObject({ id: ['UC-owned'] });
    expect(playlist.mock.calls[0][0]).toMatchObject({ playlistId: 'UU-owned' });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: 'video-owned',
      url: 'https://www.youtube.com/watch?v=video-owned',
    });
  });

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

describe('Personal LinkedIn self-service authorization', () => {
  afterEach(() => jest.restoreAllMocks());
  it('accepts the actual self-service grant and never calls the restricted legacy profile API', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) => {
        if (String(input) === 'https://www.linkedin.com/oauth/v2/accessToken')
          return new Response(
            JSON.stringify({
              access_token: 'TEST_ONLY_TOKEN',
              expires_in: 5184000,
              scope: 'openid profile w_member_social',
            })
          );
        if (String(input) === 'https://api.linkedin.com/v2/userinfo')
          return new Response(
            JSON.stringify({
              sub: 'member-id',
              name: 'Elliot',
              picture: 'https://example.com/photo.jpg',
            })
          );
        throw new Error(
          'This endpoint is not allowed by the self-service grant'
        );
      });
    const provider = new LinkedinProvider();
    const auth = await provider.generateAuthUrl();
    const url = new URL(auth.url);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'profile',
      'w_member_social',
    ]);
    expect(url.searchParams.get('prompt')).not.toBe('none');
    expect(
      await provider.authenticate({
        code: 'TEST_ONLY_CODE',
        codeVerifier: 'state',
      })
    ).toMatchObject({ id: 'member-id', name: 'Elliot', username: '' });
    expect(fetch).toHaveBeenCalledTimes(2);
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
