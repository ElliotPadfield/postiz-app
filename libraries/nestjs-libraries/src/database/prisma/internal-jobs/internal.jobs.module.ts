import { Module } from '@nestjs/common';
import { PrismaRepository, PrismaService } from '../prisma.service';
import { InternalJobsRepository } from './internal.jobs.repository';
import { InternalJobsService } from './internal.jobs.service';

// Intentionally opt-in until publisher/status reconciliation is wired and tested.
// No Temporal/Redis connection, startup polling, or provider calls in this module.
@Module({
  providers: [
    PrismaService,
    PrismaRepository,
    InternalJobsRepository,
    InternalJobsService,
  ],
  exports: [InternalJobsService],
})
export class InternalJobsModule {}
