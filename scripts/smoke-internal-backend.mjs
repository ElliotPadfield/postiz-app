import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const dbUrl = process.env.POSTIZ_QUEUE_TEST_DATABASE_URL;
if (
  !dbUrl ||
  dbUrl !== process.env.DATABASE_URL ||
  new URL(dbUrl).hostname !== '127.0.0.1' ||
  new URL(dbUrl).pathname !== '/postiz_queue_test'
)
  throw new Error('Use the disposable internal test runner.');
const jwtSecret =
  'disposable-local-backend-smoke-test-secret-not-for-deployment';
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
try {
  for (const organizationId of ['smoke-owned-org', 'smoke-foreign-org']) {
    await db.organization.upsert({
      where: { id: organizationId },
      create: { id: organizationId, name: 'Disposable smoke fixture' },
      update: {},
    });
    await db.integration.upsert({
      where: { id: `${organizationId}-channel` },
      create: {
        id: `${organizationId}-channel`,
        internalId: organizationId,
        organizationId,
        name: 'Disposable mock channel',
        providerIdentifier: 'x',
        type: 'social',
        token: 'TEST_ONLY_NOT_A_REAL_TOKEN',
      },
      update: {},
    });
    await db.post.upsert({
      where: { id: `${organizationId}-post` },
      create: {
        id: `${organizationId}-post`,
        organizationId,
        integrationId: `${organizationId}-channel`,
        group: `${organizationId}-batch`,
        content: 'Disposable draft fixture',
        state: 'DRAFT',
        publishDate: new Date(),
      },
      update: {},
    });
  }
  await db.user.upsert({
    where: { id: 'smoke-user' },
    create: {
      id: 'smoke-user',
      email: 'smoke@example.invalid',
      providerName: 'LOCAL',
      timezone: 0,
      activated: true,
    },
    update: {},
  });
  await db.userOrganization.upsert({
    where: {
      userId_organizationId: {
        userId: 'smoke-user',
        organizationId: 'smoke-owned-org',
      },
    },
    create: {
      userId: 'smoke-user',
      organizationId: 'smoke-owned-org',
      role: 'ADMIN',
    },
    update: {},
  });
} finally {
  await db.$disconnect();
}
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));

const child = spawn(
  process.execPath,
  [
    '--experimental-require-module',
    'apps/backend/dist/apps/backend/src/main.js',
  ],
  {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      RUN_WORKER: 'true',
      REDIS_URL: '',
      TEMPORAL_ADDRESS: '',
      JWT_SECRET: jwtSecret,
      FRONTEND_URL: 'http://127.0.0.1:4200',
      MAIN_URL: 'http://127.0.0.1:4200',
      NEXT_PUBLIC_BACKEND_URL: `http://127.0.0.1:${port}`,
      BACKEND_INTERNAL_URL: `http://127.0.0.1:${port}`,
      STORAGE_PROVIDER: 'local',
      UPLOAD_DIRECTORY: '/tmp/postiz-internal-test-uploads',
      EMAIL_PROVIDER: '',
      OPENAI_API_KEY: '',
      STRIPE_SECRET_KEY: '',
      SENTRY_DSN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let output = '';
child.stdout.on('data', (chunk) => {
  output = (output + chunk).slice(-12000);
});
child.stderr.on('data', (chunk) => {
  output = (output + chunk).slice(-12000);
});
let success = false;
try {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && (await response.text()) === 'App is running!') {
        success = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!success) throw new Error('Backend did not become healthy.\n' + output);
  const response = await fetch(
    `http://127.0.0.1:${port}/analytics/post/foreign/insights?days=30`
  );
  if (![401, 403].includes(response.status))
    throw new Error(
      `Protected insights route returned ${response.status} without authentication.`
    );
  const headers = {
    auth: jwt.sign({ id: 'smoke-user' }, jwtSecret),
    showorg: 'smoke-owned-org',
  };
  const cases = [
    ['/analytics/post/smoke-owned-org-post/insights?days=30', 200],
    ['/analytics/post/smoke-owned-org-post/insights/history', 200],
    ['/analytics/post/smoke-owned-org-post/insights?days=-1', 400],
    ['/analytics/post/smoke-foreign-org-post/insights?days=30', 404],
    ['/analytics/post/smoke-foreign-org-post/insights/history', 404],
    ['/posts/smoke-foreign-org-post/publishing', 404],
  ];
  for (const [path, expected] of cases) {
    const result = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    if (result.status !== expected)
      throw new Error(
        `Authenticated ${path} returned ${result.status}; expected ${expected}.`
      );
  }
  console.log(
    'Backend booted with Postgres only; health, authentication, query validation and cross-organization isolation passed. Worker enabled against disposable fixtures; no social calls made.'
  );
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000)
    ),
  ]);
}
