import { Module } from '@nestjs/common';
import { TaskController } from './task.controller.js';
import { MemoryTaskRepository } from './task.memory-repository.js';
import { TASK_REPOSITORY } from './task.repository.js';
import { TaskService } from './task.service.js';

/**
 * Provides TaskService with the in-memory repository; listed in liveImports so the Live
 * table can inject it.
 */
@Module({
  controllers: [TaskController],
  providers: [
    TaskService,
    { provide: TASK_REPOSITORY, useClass: MemoryTaskRepository },
  ],
  exports: [TaskService],
})
export class TaskModule {}
