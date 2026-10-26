import 'reflect-metadata';
import { Controller, Get, Module, Render } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestvexaModule, configureNestvexa } from 'nestvexa';
import { fileURLToPath } from 'node:url';

@Controller()
class HomeController {
  @Get()
  @Render('home')
  home() {
    return {
      title: 'Nestvexa',
      message: 'Build full-stack. Stay in Nest.',
      example: '<script>alert("escaped")</script>',
    };
  }

  @Get('about')
  @Render('about')
  about() {
    return { title: 'About Nestvexa' };
  }

  @Get('api/health')
  health() {
    return { status: 'ok', renderer: 'native-nest' };
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot({
      views: {
        root: fileURLToPath(new URL('../views', import.meta.url)),
        layout: 'layouts/main',
      },
    }),
  ],
  controllers: [HomeController],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(Number(process.env['PORT'] ?? 3100), '127.0.0.1');
console.log(`Nestvexa starter listening at ${await app.getUrl()}`);
