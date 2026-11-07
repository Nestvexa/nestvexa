import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { ShowcaseController } from './showcase.controller.js';
import { NestvexaModule } from 'nestvexa';
import { nestvexaLive, nestvexaOptions } from './nestvexa/nestvexa.config.js';
import { NestvexaWelcomeController } from './nestvexa/welcome.controller.js';
import { HomeController } from './pages/home.controller.js';
import { ReportEjsController } from './pages/report-ejs.controller.js';
import { ReportPugController } from './pages/report-pug.controller.js';
import { ReportNunjucksController } from './pages/report-nunjucks.controller.js';
import { inertiaOptions } from './nestvexa/inertia.config.js';
import { InertiaModule } from '@nestvexa/inertia';
import { ReactWelcomeController } from './pages/react-welcome.controller.js';
import { ReactDashboardController } from './pages/react-dashboard.controller.js';
import { VueWelcomeController } from './pages/vue-welcome.controller.js';
import { VueDashboardController } from './pages/vue-dashboard.controller.js';
import { SvelteWelcomeController } from './pages/svelte-welcome.controller.js';
import { SvelteDashboardController } from './pages/svelte-dashboard.controller.js';
import { actionsOptions } from './nestvexa/actions.config.js';
import { ActionsModule } from '@nestvexa/actions';
import { TaskModule } from './task/task.module.js';
import { realtimeOptions } from './nestvexa/realtime.config.js';
import { RealtimeModule } from '@nestvexa/realtime';
import { uploadsOptions } from './nestvexa/uploads.config.js';
import { UploadsModule } from '@nestvexa/uploads';
import { i18nOptions } from './nestvexa/i18n.config.js';
import { I18nModule } from '@nestvexa/i18n';

@Module({
  imports: [
    NestvexaModule.forRoot(nestvexaOptions, nestvexaLive),
    InertiaModule.forRoot(inertiaOptions()),
    ActionsModule.register(actionsOptions),
    TaskModule,
    RealtimeModule.forRoot(realtimeOptions),
    UploadsModule.register(uploadsOptions),
    I18nModule.forRootAsync({ global: true, useFactory: i18nOptions }),
  ],
  controllers: [
    AppController,
    ShowcaseController,
    NestvexaWelcomeController,
    HomeController,
    ReportEjsController,
    ReportPugController,
    ReportNunjucksController,
    ReactWelcomeController,
    ReactDashboardController,
    VueWelcomeController,
    VueDashboardController,
    SvelteWelcomeController,
    SvelteDashboardController,
  ],
  providers: [],
})
export class AppModule {}
