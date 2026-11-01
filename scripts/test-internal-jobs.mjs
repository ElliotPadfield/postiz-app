import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const compose = [
  'compose',
  '-p',
  `postiz-queue-test-${process.pid}`,
  '-f',
  'docker-compose.internal-test.yaml',
];
const schema = 'libraries/nestjs-libraries/src/database/prisma/schema.prisma';
function run(command, args, env = process.env, capture = false) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}).`);
  return result.stdout;
}

try {
  run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '45']);
  const address = run(
    'docker',
    [...compose, 'port', 'postgres', '5432'],
    process.env,
    true
  ).trim();
  if (!/^127\.0\.0\.1:\d+$/.test(address))
    throw new Error('Expected a loopback-only test database.');
  const databaseUrl = `postgresql://postiz_queue_test:local_test_only@${address}/postiz_queue_test`;
  // Override inherited connection strings: this runner never pushes to a real database.
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    POSTIZ_QUEUE_TEST_DATABASE_URL: databaseUrl,
  };
  run('pnpm', ['exec', 'prisma', 'generate', '--schema', schema], env);
  run(
    'pnpm',
    ['exec', 'prisma', 'db', 'push', '--skip-generate', '--schema', schema],
    env
  );
  run(
    'pnpm',
    [
      'exec',
      'jest',
      '--config',
      'jest.internal-jobs.config.cjs',
      '--runInBand',
    ],
    env
  );
  if (process.env.POSTIZ_TEST_BOOT === 'true') {
    run(process.execPath, ['scripts/smoke-internal-backend.mjs'], env);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const cleanup = spawnSync('docker', [...compose, 'down', '--volumes'], {
    stdio: 'inherit',
  });
  if (cleanup.status !== 0) process.exitCode = 1;
}
