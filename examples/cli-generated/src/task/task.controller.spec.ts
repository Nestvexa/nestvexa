import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { TaskController } from './task.controller.js';
import { MemoryTaskRepository } from './task.memory-repository.js';
import { TASK_REPOSITORY } from './task.repository.js';
import { TaskService } from './task.service.js';

describe('TaskController (HTTP)', () => {
  it('validates input and serves the CRUD routes', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TaskController],
      providers: [
        TaskService,
        { provide: TASK_REPOSITORY, useClass: MemoryTaskRepository },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    try {
      const url = `${await app.getUrl()}/task`;
      const send = (path: string, method: string, body?: unknown) =>
        fetch(`${url}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const invalid = await send('', 'POST', { name: 'A' });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        errors: { name: expect.any(Array) },
      });
      const created = await send('', 'POST', { name: 'Ada' });
      expect(created.status).toBe(201);
      const item = (await created.json()) as { id: number };
      expect(await (await send('?q=ad', 'GET')).json()).toEqual({
        items: [{ id: item.id, name: 'Ada' }],
        total: 1,
        page: 1,
        size: 20,
      });
      expect((await send('?size=500', 'GET')).status).toBe(400);
      expect(
        await (await send(`/${item.id}`, 'PATCH', { name: 'Grace' })).json(),
      ).toEqual({ id: item.id, name: 'Grace' });
      expect((await send(`/${item.id}`, 'DELETE')).status).toBe(204);
      expect((await send(`/${item.id}`, 'GET')).status).toBe(404);
      expect((await send('/abc', 'GET')).status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
