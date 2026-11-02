import { Injectable, Module } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { ActionGroupDefinition } from './metadata.js';

/**
 * One instance per Nest application container. Detects collisions between
 * separate `ActionsModule.register` calls during bootstrap.
 */
@Injectable()
export class ActionsApplicationRegistry {
  readonly #types = new Map<Type<object>, object>();
  readonly #routes = new Map<string, { owner: object; label: string }>();

  register(
    owner: object,
    prefix: string,
    groups: readonly ActionGroupDefinition[],
  ): void {
    for (const group of groups)
      if (this.#types.has(group.type))
        throw new Error(
          `Action group ${group.id} (${group.type.name}) is registered by more than one ActionsModule; register each group exactly once per application`,
        );
    const routes = groups.flatMap((group) =>
      group.actions.map((action) => ({
        route: `${prefix}/${group.id}/${action.path}`,
        label: `${group.type.name}.${action.method}`,
      })),
    );
    for (const { route, label } of routes) {
      const existing = this.#routes.get(route);
      if (existing)
        throw new Error(
          `Duplicate server action route POST ${route}: ${existing.label} and ${label}. Use a distinct group id, action id/version or ActionsModule prefix.`,
        );
    }
    for (const group of groups) this.#types.set(group.type, owner);
    for (const { route, label } of routes)
      this.#routes.set(route, { owner, label });
  }

  release(owner: object): void {
    for (const [type, current] of this.#types)
      if (current === owner) this.#types.delete(type);
    for (const [route, current] of this.#routes)
      if (current.owner === owner) this.#routes.delete(route);
  }
}

@Module({
  providers: [ActionsApplicationRegistry],
  exports: [ActionsApplicationRegistry],
})
export class ActionsInfrastructureModule {}
