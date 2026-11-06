import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { runSchema } from './metadata.js';
import type { SafeParseSchemaLike, StandardSchemaLike } from './metadata.js';

/**
 * Nest pipe for `@ActionInput(schemaPipe(schema))`: validates action input
 * with a Standard Schema (Zod 3.24+, Valibot, ArkType, …) or a `safeParse`
 * schema and passes the schema's parsed output to the action. Failures are
 * `400 { message: 'Invalid action input', issues: [{ path, message }] }`
 * (at most 20 issues, 200 characters each); input values are never echoed.
 */
export function schemaPipe(
  schema: StandardSchemaLike | SafeParseSchemaLike,
): PipeTransform {
  if (
    typeof schema !== 'object' ||
    schema === null ||
    (typeof Reflect.get(schema, 'safeParse') !== 'function' &&
      typeof Reflect.get(
        Object(Reflect.get(schema, '~standard')),
        'validate',
      ) !== 'function')
  )
    throw new Error(
      'schemaPipe requires a Standard Schema or safeParse schema',
    );
  return {
    async transform(value: unknown): Promise<unknown> {
      const outcome = await runSchema(schema, value);
      if (outcome.ok) return outcome.value;
      throw new BadRequestException({
        statusCode: 400,
        message: 'Invalid action input',
        issues: outcome.issues,
      });
    },
  };
}
