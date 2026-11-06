import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { INERTIA_PAGE_METADATA, PRECOGNITION_METADATA } from './constants.js';
import { InertiaConfigurationError } from './errors.js';
import { InertiaInterceptor } from './interceptor.js';
import { isPrecognitionSchema } from './precognition.js';
import type {
  PrecognitionMetadata,
  PrecognitionValidator,
  PrecognitiveOptions,
} from './precognition.js';
import type { InertiaRenderOptions } from './results.js';
import { validComponent } from './text.js';

export type InertiaPageOptions = Pick<
  InertiaRenderOptions,
  'app' | 'status' | 'encryptHistory' | 'clearHistory' | 'preserveBigIntegers'
>;

export interface InertiaPageMetadata {
  readonly component: string;
  readonly options: InertiaPageOptions;
}

const allowed = new Set([
  'app',
  'status',
  'encryptHistory',
  'clearHistory',
  'preserveBigIntegers',
]);

/**
 * Renders the handler's returned props object as the Inertia page
 * `component`. Works with ordinary Nest controllers, guards, pipes and
 * filters. Handlers may instead return `redirect()`, `back()`, `location()` or
 * `inertia()` results. Do not combine with `@Res()` (use
 * `InertiaService.render` there) or `@Render()`.
 */
export function InertiaPage(
  component: string,
  options: InertiaPageOptions = {},
): MethodDecorator {
  if (typeof component !== 'string' || !validComponent(component))
    throw new InertiaConfigurationError(
      '@InertiaPage requires a component name',
    );
  if (typeof options !== 'object' || options === null)
    throw new InertiaConfigurationError(
      '@InertiaPage options must be an object',
    );
  for (const key of Object.keys(options))
    if (!allowed.has(key))
      throw new InertiaConfigurationError(
        `Unknown @InertiaPage option "${key}"`,
      );
  const metadata: InertiaPageMetadata = Object.freeze({
    component,
    options: Object.freeze({ ...options }),
  });
  return applyDecorators(
    SetMetadata(INERTIA_PAGE_METADATA, metadata),
    UseInterceptors(InertiaInterceptor),
  );
}

/**
 * Applies the Inertia interceptor to a controller or handler that returns
 * Inertia results without rendering a fixed page (for example form actions).
 * Unnecessary when the module's interceptor is registered globally (default).
 */
export function UseInertia(): ClassDecorator & MethodDecorator {
  return UseInterceptors(InertiaInterceptor);
}

/**
 * Answers Precognition requests for this route with validation only: the
 * handler (and its pipes) never runs for them. Passing input answers `204`
 * with `Precognition-Success: true`; failing input answers `422` with
 * `{ message, errors }` (errors as message arrays, filtered by
 * `Precognition-Validate-Only`). Every response of the route carries
 * `Vary: Precognition`. Ordinary submissions reach the handler unchanged, so
 * validate them there as usual (for example with the same adapter).
 *
 * ```ts
 * const user = zodAdapter(z.object({ name: z.string().min(1) }));
 * @Post('users') @Precognitive(user) store(@Body() body: unknown) { ... }
 * ```
 */
export function Precognitive(
  validator: PrecognitionValidator,
  options: PrecognitiveOptions = {},
): MethodDecorator {
  if (typeof validator !== 'function' && !isPrecognitionSchema(validator))
    throw new InertiaConfigurationError(
      '@Precognitive requires a validator function or a schema with validate()',
    );
  if (typeof options !== 'object' || options === null)
    throw new InertiaConfigurationError(
      '@Precognitive options must be an object',
    );
  for (const key of Object.keys(options))
    if (key !== 'input')
      throw new InertiaConfigurationError(
        `Unknown @Precognitive option "${key}"`,
      );
  if (options.input !== undefined && typeof options.input !== 'function')
    throw new InertiaConfigurationError(
      '@Precognitive input must be a function',
    );
  const metadata: PrecognitionMetadata = Object.freeze({
    validator,
    input: options.input,
  });
  return applyDecorators(
    SetMetadata(PRECOGNITION_METADATA, metadata),
    UseInterceptors(InertiaInterceptor),
  );
}
