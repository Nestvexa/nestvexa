/** Process settings shared by the bootstrap and the controllers. */
export const APP_SETTINGS = Symbol('APP_SETTINGS');
export interface AppSettings {
  /** Exact public origin, used in mailed links and Origin checks. */
  readonly origin: string;
  readonly allowedOrigins: readonly string[];
}
