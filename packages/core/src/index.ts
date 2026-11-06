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
  RequestContextFactory,
  NESTVEXA_REQUEST_CONTEXT_OPTIONS,
  type ContextValue,
  type NestvexaRequestContext,
  type PublicRequestContext,
  type RequestContextContributor,
  type RequestContextOptions,
  type RequestPrincipal,
} from './context.js';
export {
  SecurityPolicyRegistry,
  SECURITY_POLICY_KINDS,
  exactOriginPolicy,
  type SecurityPolicies,
  type SecurityPolicyKind,
  type SecurityPolicyReport,
} from './security.js';
export {
  DiagnosticsRegistry,
  NESTVEXA_DIAGNOSTICS_OPTIONS,
  type DiagnosticAttributes,
  type DiagnosticDefinition,
  type DiagnosticKind,
  type DiagnosticListener,
  type DiagnosticOutcome,
  type DiagnosticRecord,
  type DiagnosticSpan,
  type DiagnosticsOptions,
} from './diagnostics.js';
export {
  DEFAULT_SENSITIVE_KEYS,
  REDACTED,
  createRedactingLogger,
  createRedactor,
  redact,
  type RedactionOptions,
  type Redactor,
} from './redaction.js';
export {
  NestvexaExceptionFilter,
  NESTVEXA_ERROR_LOGGER,
  NESTVEXA_ERROR_REDACTION,
  type NestvexaErrorBody,
} from './exceptions.js';
export {
  NestvexaExtensionHost,
  NESTVEXA_EXTENSIONS,
  defineExtension,
  type NestvexaExtension,
  type NestvexaExtensionContext,
} from './extensions.js';
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
