# API coexistence

One Nest process serving, side by side:

- REST controllers under `/api` with the host's own `ApiKeyGuard`;
- GraphQL at `/graphql` (`@nestjs/graphql` + Apollo, schema-first) with a
  GraphQL guard;
- a TCP microservice (`@nestjs/microservices`, hybrid application);
- a Nest WebSocket gateway at `/ws/items` (`@nestjs/platform-ws`);
- a Nestvexa page with a Live component, the Live action endpoint and the
  Nestvexa realtime WebSocket transport.

Nestvexa adds no global guard, pipe, filter, interceptor or middleware, so the
APIs answer exactly as they would without it, and the API guards never apply to
Nestvexa routes. The GraphQL, microservice and WebSocket packages are pinned
devDependencies of this example only.

```sh
pnpm --filter @nestvexa/example-api-coexistence build
PORT=3885 pnpm --filter @nestvexa/example-api-coexistence start
```

`tests/api-coexistence.test.ts` boots the application in-process and exercises
every transport.
