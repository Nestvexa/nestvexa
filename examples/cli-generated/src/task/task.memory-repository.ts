import { Injectable } from '@nestjs/common';
import type { CreateTaskDto, TaskQuery, UpdateTaskDto } from './task.dto.js';
import type { Task, TaskPage, TaskRepository } from './task.repository.js';

/** In-process TaskRepository: one list per application process, lost on restart. */
@Injectable()
export class MemoryTaskRepository implements TaskRepository {
  #items: Task[] = [];
  #next = 1;
  async list({ q, page, size }: TaskQuery): Promise<TaskPage> {
    const needle = q?.toLowerCase();
    const matches = needle
      ? this.#items.filter((item) => item.name.toLowerCase().includes(needle))
      : this.#items;
    return {
      items: matches.slice((page - 1) * size, page * size),
      total: matches.length,
      page,
      size,
    };
  }
  async find(id: number): Promise<Task | undefined> {
    return this.#items.find((item) => item.id === id);
  }
  async create(input: CreateTaskDto): Promise<Task> {
    const item = { id: this.#next++, name: input.name };
    this.#items = [...this.#items, item];
    return item;
  }
  async update(id: number, input: UpdateTaskDto): Promise<Task | undefined> {
    const current = await this.find(id);
    if (!current) return undefined;
    const item = {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
    };
    this.#items = this.#items.map((entry) => (entry.id === id ? item : entry));
    return item;
  }
  async remove(id: number): Promise<boolean> {
    const before = this.#items.length;
    this.#items = this.#items.filter((item) => item.id !== id);
    return this.#items.length !== before;
  }
}
