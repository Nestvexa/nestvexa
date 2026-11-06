export {
  CoreModule,
  type CoreModuleRegistration,
  type NestvexaAsyncOptions,
  type NestvexaOptionsFactory,
} from './core.module.js';
export {
  NestvexaConfigService,
  NESTVEXA_ENVIRONMENT_VARIABLES,
  NESTVEXA_OPTIONS,
  mergeNestvexaOptions,
  nestvexaOptionsFromEnvironment,
  normalizeOptions,
  type NestvexaLiveClient,
  type NestvexaOptions,
  type NormalizedNestvexaOptions,
} from './config.js';
export {
  CollisionSafeRegistry,
  FeatureCapabilityRegistry,
  type FeatureCapability,
} from './registry.js';
export {
  NESTVEXA_ERROR_CODES,
  NestvexaConfigError,
  NestvexaError,
  type NestvexaConfigIssue,
  type NestvexaErrorCode,
} from './errors.js';
export {
  RouteName,
  buildPath,
  collectRoutes,
  generateRouteModule,
  moduleControllers,
  routeParams,
  type CollectRoutesOptions,
  type RouteDefinition,
  type RouteParam,
} from './routes.js';
export {
  PLUGIN_CAPABILITIES,
  PluginRegistry,
  definePlugin,
  parsePluginManifest,
  satisfiesVersion,
  type NestvexaPlugin,
  type NestvexaPluginManifest,
  type PluginCapability,
  type PluginSetupContext,
} from './plugins.js';
