import { zodAdapter } from '@nestvexa/forms';
import { z } from 'zod';

/**
 * Input rules shared by the REST controller and the Live table. The server
 * always validates; unknown keys are rejected.
 */
export const createTaskSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(2, 'Enter at least 2 characters.')
    .max(80, 'Use at most 80 characters.'),
});
export const updateTaskSchema = createTaskSchema.partial();
/** List query: optional search, 1-based page, bounded page size. */
export const taskQuerySchema = z.strictObject({
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateTaskDto = z.infer<typeof createTaskSchema>;
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;
export type TaskQuery = z.infer<typeof taskQuerySchema>;

export const createTaskAdapter = zodAdapter(createTaskSchema);
export const updateTaskAdapter = zodAdapter(updateTaskSchema);
export const taskQueryAdapter = zodAdapter(taskQuerySchema);
