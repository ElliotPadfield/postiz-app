import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcrypt';

const url = process.env.POSTIZ_QUEUE_TEST_DATABASE_URL;
if (
  !url ||
  url !== process.env.DATABASE_URL ||
  new URL(url).hostname !== '127.0.0.1' ||
  new URL(url).pathname !== '/postiz_queue_test'
)
  throw new Error('Use the disposable test runner.');
const db = new PrismaClient();
try {
  if (await db.organization.count())
    throw new Error('Bootstrap test requires an empty disposable database.');
  const password = 'disposable-bootstrap-fixture-password-123';
  const env = {
    ...process.env,
    BOOTSTRAP_OWNER_EMAIL: 'owner@example.invalid',
    BOOTSTRAP_OWNER_PASSWORD: password,
    JWT_SECRET: 'disposable-bootstrap-fixture-jwt-secret',
  };
  const first = spawnSync(
    process.execPath,
    ['--experimental-require-module', 'scripts/bootstrap-owner.cjs'],
    { env, encoding: 'utf8' }
  );
  if (first.status !== 0) throw new Error('First-owner bootstrap failed.');
  const owner = await db.user.findFirstOrThrow({
    where: { email: 'owner@example.invalid' },
    select: {
      password: true,
      activated: true,
      organizations: { select: { role: true } },
    },
  });
  if (
    !bcrypt.compareSync(password, owner.password) ||
    !owner.activated ||
    owner.organizations[0]?.role !== 'SUPERADMIN'
  )
    throw new Error('Bootstrap did not create the intended active owner.');
  const second = spawnSync(
    process.execPath,
    ['--experimental-require-module', 'scripts/bootstrap-owner.cjs'],
    {
      env: {
        ...env,
        BOOTSTRAP_OWNER_PASSWORD: 'different-disposable-password-456',
      },
      encoding: 'utf8',
    }
  );
  const existing = await db.user.findFirstOrThrow({
    where: { email: 'owner@example.invalid' },
    select: { password: true },
  });
  if (
    second.status !== 0 ||
    existing.password !== owner.password ||
    (await db.organization.count()) !== 1
  )
    throw new Error(
      'Bootstrap changed existing credentials or created another workspace.'
    );
  console.log('First-owner bootstrap and restart preservation passed.');
} finally {
  await db.$disconnect();
}
