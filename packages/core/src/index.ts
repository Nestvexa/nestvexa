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
