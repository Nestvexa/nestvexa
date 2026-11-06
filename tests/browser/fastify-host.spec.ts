import { exampleUrl } from './example-url.js';
import { defineHostSuite } from './host-adapter-suite.js';

// examples/fastify-host: the shared application on @nestjs/platform-fastify.
defineHostSuite({
  platform: 'fastify',
  base: exampleUrl('fastify-host', 3121),
});
