import session from 'express-session';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureNestvexa } from 'nestvexa';
import { sessionSecret } from './nestvexa/nestvexa.config.js';
import { registerEjsEngine } from './nestvexa/engines/ejs.engine.js';
import { registerPugEngine } from './nestvexa/engines/pug.engine.js';
import { registerNunjucksEngine } from './nestvexa/engines/nunjucks.engine.js';
import { configureInertia } from './nestvexa/inertia.config.js';
import { configureIslands } from './nestvexa/islands.serve.js';
import { configureUploads } from '@nestvexa/uploads';
import { configureI18n } from './nestvexa/i18n.config.js';
import { configureRouteHelpers } from './nestvexa/route-helpers.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });
  // nestvexa:setup — guest sessions for Live CSRF/identity (replace for production)
  app.use(
    session({
      secret: sessionSecret(),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env['NODE_ENV'] === 'production',
      },
    }),
  );
  configureI18n(app);
  configureRouteHelpers(app);
  await configureNestvexa(app);
  await registerEjsEngine(app);
  await registerPugEngine(app);
  await registerNunjucksEngine(app);
  configureInertia(app);
  configureIslands(app);
  await configureUploads(app);
  await app.listen(Number(process.env['PORT'] ?? 3000), '127.0.0.1');
}
void bootstrap();
