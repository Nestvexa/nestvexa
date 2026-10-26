export { CoreModule, type NestvexaAsyncOptions } from './core.module.js';
export {
  NestvexaConfigService,
  NESTVEXA_OPTIONS,
  normalizeOptions,
  type NestvexaOptions,
  type NormalizedNestvexaOptions,
} from './config.js';
export {
  CollisionSafeRegistry,
  FeatureCapabilityRegistry,
  type FeatureCapability,
} from './registry.js';
export { NestvexaError, type NestvexaErrorCode } from './errors.js';
