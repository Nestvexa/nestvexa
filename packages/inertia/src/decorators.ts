import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { INERTIA_PAGE_METADATA } from './constants.js';
import { InertiaConfigurationError } from './errors.js';
import { InertiaInterceptor } from './interceptor.js';
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
