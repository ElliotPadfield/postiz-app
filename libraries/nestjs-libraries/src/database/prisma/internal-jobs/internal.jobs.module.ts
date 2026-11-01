import { Module } from '@nestjs/common';
import { PrismaRepository, PrismaService } from '../prisma.service';
import { InternalJobsRepository } from './internal.jobs.repository';
import { InternalJobsService } from './internal.jobs.service';

// Lightweight module for isolated queue consumers/tests. The application
// registers the same services plus the worker in DatabaseModule.
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
