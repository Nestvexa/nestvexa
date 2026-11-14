import { describe, expect, it } from 'vitest';
import {
  createTaskAdapter,
  taskQueryAdapter,
  updateTaskAdapter,
} from './task.dto.js';

describe('Task DTOs', () => {
  it('trims valid names and rejects short, long and unknown fields', async () => {
    expect(await createTaskAdapter.validate({ name: '  Ada  ' })).toEqual({
      ok: true,
      value: { name: 'Ada' },
    });
    for (const input of [
      { name: 'A' },
      { name: 'x'.repeat(81) },
      { name: 'Ada', admin: true },
      {},
    ]) {
      const result = await createTaskAdapter.validate(input);
      expect(result.ok).toBe(false);
    }
    expect(await updateTaskAdapter.validate({})).toEqual({
      ok: true,
      value: {},
    });
  });
  it('coerces and bounds the list query', async () => {
    expect(await taskQueryAdapter.validate({ page: '2' })).toEqual({
      ok: true,
      value: { page: 2, size: 20 },
    });
    expect((await taskQueryAdapter.validate({ size: '1000' })).ok).toBe(false);
    expect((await taskQueryAdapter.validate({ page: '0' })).ok).toBe(false);
  });
});
