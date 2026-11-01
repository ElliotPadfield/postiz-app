// Opt-in first-owner initialization, before the HTTP processes are started.
// Credentials come from private runtime environment variables and are never logged.
const { PrismaClient, Prisma } = require('@prisma/client');
const { randomBytes } = require('node:crypto');
const {
  AuthService,
} = require('../apps/backend/dist/libraries/helpers/src/auth/auth.service.js');

async function bootstrap() {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase();
  if (!email) return;
  const db = new PrismaClient();
  try {
    await db.$transaction(
      async (tx) => {
        // Do not reset passwords, claim an existing workspace, or add owners on restart.
        if (await tx.organization.count()) return;
        const password = process.env.BOOTSTRAP_OWNER_PASSWORD || '';
        if (
          !email.includes('@') ||
          password.length < 24 ||
          !process.env.JWT_SECRET
        ) {
          throw new Error(
            'First-owner bootstrap requires a valid email, a strong password and JWT_SECRET.'
          );
        }
        await tx.organization.create({
          data: {
            name: 'Content',
            apiKey: AuthService.fixedEncryption(
              randomBytes(32).toString('hex')
            ),
            users: {
              create: {
                role: 'SUPERADMIN',
                user: {
                  create: {
                    email,
                    name: 'Elliot Padfield',
                    providerName: 'LOCAL',
                    activated: true,
                    password: AuthService.hashPassword(password),
                    timezone: 0,
                  },
                },
              },
            },
          },
          select: { id: true },
        });
        console.log(
          'Initial owner account created. Public registration remains disabled.'
        );
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
      }
    );
  } finally {
    await db.$disconnect();
  }
}

bootstrap().catch(() => {
  console.error('Owner bootstrap failed; application startup stopped.');
  process.exitCode = 1;
});
