import { BadRequestException } from '@nestjs/common';

/** A developer configuration or programming error. Never caused by a client. */
export class InertiaConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InertiaConfigurationError';
  }
}

/**
 * A prop or flash value that cannot be represented in the page object. The
 * message names the path but never echoes the offending value.
 */
export class InertiaSerializationError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Cannot serialize Inertia value at ${path || '<root>'}: ${reason}`);
    this.name = 'InertiaSerializationError';
  }
}

/** A malformed `X-Inertia-*` request header. Responds with 400. */
export class InertiaRequestError extends BadRequestException {
  constructor(readonly header: string) {
    super(`Malformed ${header} header`);
    this.name = 'InertiaRequestError';
  }
}

/** A redirect target rejected by the configured redirect policy. Responds with 400. */
export class InertiaRedirectError extends BadRequestException {
  constructor() {
    super('Unsafe redirect target');
    this.name = 'InertiaRedirectError';
  }
}
