import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MemoryTaskRepository } from './task.memory-repository.js';
import { TaskService } from './task.service.js';

describe('TaskService', () => {
  it('creates, searches, pages, updates and removes records', async () => {
    const service = new TaskService(new MemoryTaskRepository());
    const first = await service.create({ name: 'Alpha' });
    await service.create({ name: 'Beta' });
    await service.create({ name: 'Alphabet' });
    expect((await service.list({ q: 'alpha', page: 1, size: 20 })).total).toBe(
      2,
    );
    expect(await service.list({ page: 2, size: 2 })).toMatchObject({
      total: 3,
      items: [{ name: 'Alphabet' }],
    });
    expect(await service.update(first.id, { name: 'Gamma' })).toEqual({
      id: first.id,
      name: 'Gamma',
    });
    await service.remove(first.id);
    await expect(service.get(first.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(first.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
