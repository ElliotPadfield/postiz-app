module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/internal-jobs/*.spec.ts',
  ],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'es2021',
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      },
    ],
  },
  testTimeout: 15000,
};
