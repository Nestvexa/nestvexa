import { exampleUrl } from './example-url.js';
import { defineHostSuite } from './host-adapter-suite.js';

// examples/express-host: the shared application on @nestjs/platform-express.
defineHostSuite({
  platform: 'express',
  base: exampleUrl('express-host', 3120),
});
