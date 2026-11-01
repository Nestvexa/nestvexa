import { Injectable, Module } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { ContextIdFactory } from '@nestjs/core';
import type { SafeHtml } from '@nestvexa/views';
import type { ComponentDefinition } from './metadata.js';
import { INTERNAL_SYNC_PATH } from './metadata.js';
import type { TextStreamAuthorization } from './text-stream.js';

export interface LiveRegistrationOwner {
  mount(type: Type<object>, request: object): Promise<SafeHtml>;
  authorizeStream(
    request: object,
    type: Type<object>,
    streamId: string,
    reference: Readonly<{ snapshot: string; revision: number }>,
  ): Promise<TextStreamAuthorization>;
}

/** One provider instance per Nest application container; it never stores browser-selected classes. */
@Injectable()
export class LiveApplicationRegistry {
  readonly #owners = new Map<Type<object>, LiveRegistrationOwner>();
  readonly #names = new Map<string, LiveRegistrationOwner>();
  readonly #routes = new Map<string, LiveRegistrationOwner>();
  readonly #contexts = new WeakMap<
    object,
    ReturnType<typeof ContextIdFactory.getByRequest>
  >();

  register(
    owner: LiveRegistrationOwner,
    definitions: readonly ComponentDefinition[],
    endpoint: string,
  ): void {
    const routes = definitions.flatMap((component) =>
      [...component.actions.keys(), INTERNAL_SYNC_PATH].map(
        (action) => `${endpoint}/${component.name}/${action}`,
      ),
    );
    for (const component of definitions) {
      if (this.#owners.has(component.type) || this.#names.has(component.name))
        throw new Error(
          `Duplicate Live component registration: ${component.name}. Register each component once per Nest application.`,
        );
    }
    for (const route of routes)
      if (this.#routes.has(route))
        throw new Error(`Duplicate Live action route: ${route}`);
    for (const component of definitions) {
      this.#owners.set(component.type, owner);
      this.#names.set(component.name, owner);
    }
    for (const route of routes) this.#routes.set(route, owner);
  }

  owner(type: Type<object>): LiveRegistrationOwner | undefined {
    return this.#owners.get(type);
  }

  context(request: object): ReturnType<typeof ContextIdFactory.getByRequest> {
    const known = this.#contexts.get(request);
    if (known) return known;
    const context = ContextIdFactory.getByRequest(request);
    this.#contexts.set(request, context);
    return context;
  }

  release(owner: LiveRegistrationOwner): void {
    for (const [type, current] of this.#owners)
      if (current === owner) this.#owners.delete(type);
    for (const [name, current] of this.#names)
      if (current === owner) this.#names.delete(name);
    for (const [route, current] of this.#routes)
      if (current === owner) this.#routes.delete(route);
  }
}

@Module({
  providers: [LiveApplicationRegistry],
  exports: [LiveApplicationRegistry],
})
export class LiveInfrastructureModule {}
