import type { CreateTaskDto, TaskQuery, UpdateTaskDto } from './task.dto.js';

export interface Task {
  readonly id: number;
  readonly name: string;
}
export interface TaskPage {
  readonly items: readonly Task[];
  readonly total: number;
  readonly page: number;
  readonly size: number;
}

/**
 * Data access of TaskService. `TaskModule` binds the implementation
 * chosen with `make:resource --orm`; tests use the in-memory one.
 */
export interface TaskRepository {
  list(query: TaskQuery): Promise<TaskPage>;
  find(id: number): Promise<Task | undefined>;
  create(input: CreateTaskDto): Promise<Task>;
  /** Undefined when the record does not exist. */
  update(id: number, input: UpdateTaskDto): Promise<Task | undefined>;
  /** False when the record does not exist. */
  remove(id: number): Promise<boolean>;
}
export const TASK_REPOSITORY = Symbol('TaskRepository');
