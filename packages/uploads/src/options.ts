import { isAbsolute, normalize, resolve } from 'node:path';
import { FILE_TYPES, defineFileType } from './file-types.js';
import type { BuiltInFileType, FileTypeDefinition } from './file-types.js';
import { isInstrumentation } from './instrumentation.js';
import type { UploadInstrumentation } from './instrumentation.js';
import { LocalStorage } from './storage.js';
import type { UploadStorage } from './storage.js';
import type { UploadScanner } from './scanner.js';
import { isUploadPolicyRegistry } from './policies.js';
import type { UploadPolicyRegistry } from './policies.js';

/** Host-resolved identity: the same binding/CSRF contract as Live, plus an optional tenant. */
export interface UploadIdentity {
  /** Stable per session/user/tenant binding, 16–1024 characters. Never from request bodies. */
  readonly binding: string;
  readonly csrfToken: string;
  /** Tenant quota bucket, 1–256 characters. */
  readonly tenant?: string;
}
export type UploadOperation = 'upload' | 'finalize' | 'discard';

export interface UploadPurposeOptions {
  /** Allowed built-in names (`png`, `jpeg`, `gif`, `webp`, `pdf`, `txt`, `csv`) or custom definitions. */
  readonly types: readonly (BuiltInFileType | FileTypeDefinition)[];
  /** Bytes per file, 1 byte – 5 GiB. */
  readonly maxFileSize: number;
  /** Pending (unfinalized) uploads per identity for this purpose and files per form request. Default 10. */
  readonly maxFiles?: number;
  /** Accept 0-byte files (text types only). Default false. */
  readonly allowEmpty?: boolean;
  /** Refuse finalization unless a scanner is configured and reports clean. Default false. */
  readonly requireScan?: boolean;
  /** Offer presigned direct-to-storage uploads when the storage adapter supports it. Default false. */
  readonly direct?: boolean;
}
export interface UploadQuotaOptions {
  /** Pending uploads per identity binding. Default 20. */
  readonly identityFiles?: number;
  /** Pending bytes per identity binding. Default 256 MiB. */
  readonly identityBytes?: number;
  /** Pending uploads per tenant. Default 200. */
  readonly tenantFiles?: number;
  /** Pending bytes per tenant. Default 2 GiB. */
  readonly tenantBytes?: number;
  /** Pending uploads in this process. Default 2000. */
  readonly totalFiles?: number;
  /** Pending bytes in this process (temporary disk). Default 8 GiB. */
  readonly totalBytes?: number;
  /** Simultaneous body-reading requests per identity. Default 4. */
  readonly concurrentPerIdentity?: number;
  /** Upload API requests per identity per minute. Default 240. */
  readonly requestsPerMinute?: number;
}
export interface UploadsHostOptions {
  /** Exact public HTTP(S) origin; state-changing requests must send it. */
  readonly origin: string;
  /** Absolute private directory (outside any webroot) for temporary files and default local storage. */
  readonly directory: string;
  readonly resolveIdentity: (
    request: object,
  ) => UploadIdentity | Promise<UploadIdentity>;
  /** Checked for every upload, finalize and discard. */
  readonly authorize: (
    identity: UploadIdentity,
    purpose: string,
    operation: UploadOperation,
  ) => boolean | Promise<boolean>;
  /** Explicit purposes; Live fields use `<component-name>.<field>`. */
  readonly purposes: Readonly<Record<string, UploadPurposeOptions>>;
  /** Default `LocalStorage` at `<directory>/objects`. */
  readonly storage?: UploadStorage;
  /** Optional malware scanner run during finalization. */
  readonly scanner?: UploadScanner;
  /** Default 60000ms. */
  readonly scanTimeoutMs?: number;
  /** Temporary token/session lifetime. Default 15 minutes (10s–24h). */
  readonly tokenTtlMs?: number;
  /** Chunk size for resumable sessions. Default 1 MiB (16 KiB–16 MiB). */
  readonly chunkSize?: number;
  /** Abort a request body that stalls this long. Default 30000ms. */
  readonly idleTimeoutMs?: number;
  /** Abort a request body that takes longer than this in total. Default 10 minutes. */
  readonly maxRequestMs?: number;
  /** Expired-file sweep interval. Default 60000ms. */
  readonly sweepIntervalMs?: number;
  readonly quotas?: UploadQuotaOptions;
  /**
   * Optional structural tracing hook (for example from
   * @nestvexa/observability). Emits `nestvexa.upload.receive` and
   * `nestvexa.upload.finalize` spans with purpose, mode and sizes only.
   */
  readonly instrumentation?: UploadInstrumentation;
  /**
   * Kernel security policy registry (structural; for example
   * `SecurityPolicyRegistry` from @nestvexa/core). Uploads registers its
   * origin, CSRF, authorization and `upload-quota` policies under
   * `policyOwner` at startup and asks the registry for every origin,
   * CSRF-header and authorization decision.
   */
  readonly policies?: UploadPolicyRegistry;
  /** Owner name for `policies` (default `uploads`); a duplicate owner fails startup. */
  readonly policyOwner?: string;
}

export interface ResolvedPurpose {
  readonly name: string;
  readonly types: readonly FileTypeDefinition[];
  readonly byExtension: ReadonlyMap<string, FileTypeDefinition>;
  readonly maxFileSize: number;
  readonly maxFiles: number;
  readonly allowEmpty: boolean;
  readonly requireScan: boolean;
  readonly direct: boolean;
}
export interface ResolvedOptions {
  readonly origin: string;
  readonly directory: string;
  readonly tempDirectory: string;
  readonly resolveIdentity: UploadsHostOptions['resolveIdentity'];
  readonly authorize: UploadsHostOptions['authorize'];
  readonly purposes: ReadonlyMap<string, ResolvedPurpose>;
  readonly storage: UploadStorage;
  readonly scanner: UploadScanner | undefined;
  readonly scanTimeoutMs: number;
  readonly tokenTtlMs: number;
  readonly chunkSize: number;
  readonly idleTimeoutMs: number;
  readonly maxRequestMs: number;
  readonly sweepIntervalMs: number;
  readonly quotas: Required<UploadQuotaOptions>;
  readonly instrumentation: UploadInstrumentation | undefined;
  readonly policies: UploadPolicyRegistry | undefined;
  readonly policyOwner: string;
}

export const PURPOSE_PATTERN =
  /^[a-zA-Z][a-zA-Z0-9_-]{0,63}(?:\.[a-zA-Z][a-zA-Z0-9_-]{0,63})?$/;
const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    result < min ||
    result > max
  )
    throw new Error(
      `Invalid uploads option ${label}: expected an integer from ${min} through ${max}`,
    );
  return result;
}
function plain(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`Invalid ${label}`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
      throw new Error(`${label} must use plain data properties`);
  }
}
function purpose(name: string, value: unknown): ResolvedPurpose {
  plain(value, `upload purpose ${name}`);
  for (const key of Object.keys(value))
    if (
      ![
        'types',
        'maxFileSize',
        'maxFiles',
        'allowEmpty',
        'requireScan',
        'direct',
      ].includes(key)
    )
      throw new Error(`Unknown option ${key} for upload purpose ${name}`);
  const types = value['types'];
  if (!Array.isArray(types) || types.length < 1 || types.length > 32)
    throw new Error(`Upload purpose ${name} requires 1–32 allowed types`);
  const resolved = types.map((entry: unknown): FileTypeDefinition => {
    if (typeof entry === 'string') {
      if (!Object.hasOwn(FILE_TYPES, entry))
        throw new Error(
          `Unknown built-in file type ${entry} for purpose ${name}`,
        );
      return FILE_TYPES[entry as BuiltInFileType];
    }
    return defineFileType(entry as FileTypeDefinition);
  });
  const byExtension = new Map<string, FileTypeDefinition>();
  for (const type of resolved)
    for (const extension of type.extensions) {
      if (byExtension.has(extension))
        throw new Error(
          `Extension ${extension} is declared twice for purpose ${name}`,
        );
      byExtension.set(extension, type);
    }
  for (const flag of ['allowEmpty', 'requireScan', 'direct'])
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean')
      throw new Error(`Upload purpose ${name}.${flag} must be a boolean`);
  return Object.freeze({
    name,
    types: Object.freeze(resolved),
    byExtension,
    maxFileSize: integer(
      value['maxFileSize'],
      -1,
      1,
      5 * GiB,
      `${name}.maxFileSize`,
    ),
    maxFiles: integer(value['maxFiles'], 10, 1, 100, `${name}.maxFiles`),
    allowEmpty: value['allowEmpty'] === true,
    requireScan: value['requireScan'] === true,
    direct: value['direct'] === true,
  });
}

/** Validate host options once; unknown keys and accessor properties are rejected. */
export function resolveOptions(options: UploadsHostOptions): ResolvedOptions {
  plain(options, 'uploads options');
  const allowed = [
    'origin',
    'directory',
    'resolveIdentity',
    'authorize',
    'purposes',
    'storage',
    'scanner',
    'scanTimeoutMs',
    'tokenTtlMs',
    'chunkSize',
    'idleTimeoutMs',
    'maxRequestMs',
    'sweepIntervalMs',
    'quotas',
    'instrumentation',
    'policies',
    'policyOwner',
    'endpoint',
    'global',
    'imports',
  ];
  for (const key of Object.keys(options))
    if (!allowed.includes(key))
      throw new Error(`Unknown uploads option ${key}`);
  const origin = new URL(options.origin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== options.origin
  )
    throw new Error('Uploads origin must be an exact HTTP(S) origin');
  if (
    typeof options.resolveIdentity !== 'function' ||
    typeof options.authorize !== 'function'
  )
    throw new Error('Uploads identity and authorization policies are required');
  if (
    typeof options.directory !== 'string' ||
    !isAbsolute(options.directory) ||
    options.directory.includes('\u0000')
  )
    throw new Error('Uploads directory must be an absolute private path');
  const directory = resolve(normalize(options.directory));
  plain(options.purposes, 'upload purposes');
  const purposes = new Map<string, ResolvedPurpose>();
  for (const [name, value] of Object.entries(options.purposes)) {
    if (!PURPOSE_PATTERN.test(name))
      throw new Error(`Invalid upload purpose name ${name}`);
    purposes.set(name, purpose(name, value));
  }
  if (!purposes.size)
    throw new Error('At least one upload purpose is required');
  const storage: UploadStorage =
    options.storage ??
    new LocalStorage({ directory: resolve(directory, 'objects') });
  if (
    !storage ||
    typeof storage.kind !== 'string' ||
    typeof storage.put !== 'function' ||
    typeof storage.open !== 'function' ||
    typeof storage.stat !== 'function' ||
    typeof storage.delete !== 'function'
  )
    throw new Error('Invalid upload storage adapter');
  for (const entry of purposes.values())
    if (entry.direct && typeof storage.presignUpload !== 'function')
      throw new Error(
        `Purpose ${entry.name} requests direct uploads but storage cannot presign`,
      );
  if (
    options.scanner !== undefined &&
    (typeof options.scanner?.scan !== 'function' ||
      typeof options.scanner.name !== 'string')
  )
    throw new Error('Invalid upload scanner');
  const quotas = options.quotas ?? {};
  plain(quotas, 'upload quotas');
  const quotaKeys = [
    'identityFiles',
    'identityBytes',
    'tenantFiles',
    'tenantBytes',
    'totalFiles',
    'totalBytes',
    'concurrentPerIdentity',
    'requestsPerMinute',
  ];
  for (const key of Object.keys(quotas))
    if (!quotaKeys.includes(key))
      throw new Error(`Unknown upload quota ${key}`);
  return Object.freeze({
    origin: options.origin,
    directory,
    tempDirectory: resolve(directory, 'tmp'),
    resolveIdentity: options.resolveIdentity,
    authorize: options.authorize,
    purposes,
    storage,
    scanner: options.scanner,
    scanTimeoutMs: integer(
      options.scanTimeoutMs,
      60_000,
      100,
      600_000,
      'scanTimeoutMs',
    ),
    tokenTtlMs: integer(
      options.tokenTtlMs,
      15 * 60_000,
      10_000,
      24 * 3_600_000,
      'tokenTtlMs',
    ),
    chunkSize: integer(
      options.chunkSize,
      MiB,
      16 * 1024,
      16 * MiB,
      'chunkSize',
    ),
    idleTimeoutMs: integer(
      options.idleTimeoutMs,
      30_000,
      100,
      600_000,
      'idleTimeoutMs',
    ),
    maxRequestMs: integer(
      options.maxRequestMs,
      10 * 60_000,
      1000,
      6 * 3_600_000,
      'maxRequestMs',
    ),
    sweepIntervalMs: integer(
      options.sweepIntervalMs,
      60_000,
      50,
      3_600_000,
      'sweepIntervalMs',
    ),
    quotas: Object.freeze({
      identityFiles: integer(
        quotas['identityFiles'],
        20,
        1,
        10_000,
        'quotas.identityFiles',
      ),
      identityBytes: integer(
        quotas['identityBytes'],
        256 * MiB,
        1,
        1024 * GiB,
        'quotas.identityBytes',
      ),
      tenantFiles: integer(
        quotas['tenantFiles'],
        200,
        1,
        100_000,
        'quotas.tenantFiles',
      ),
      tenantBytes: integer(
        quotas['tenantBytes'],
        2 * GiB,
        1,
        1024 * GiB,
        'quotas.tenantBytes',
      ),
      totalFiles: integer(
        quotas['totalFiles'],
        2000,
        1,
        1_000_000,
        'quotas.totalFiles',
      ),
      totalBytes: integer(
        quotas['totalBytes'],
        8 * GiB,
        1,
        1024 * 1024 * GiB,
        'quotas.totalBytes',
      ),
      concurrentPerIdentity: integer(
        quotas['concurrentPerIdentity'],
        4,
        1,
        64,
        'quotas.concurrentPerIdentity',
      ),
      requestsPerMinute: integer(
        quotas['requestsPerMinute'],
        240,
        1,
        100_000,
        'quotas.requestsPerMinute',
      ),
    }),
    instrumentation: instrumentation(options.instrumentation),
    policies: policyRegistry(options.policies),
    policyOwner: policyOwner(options.policyOwner, options.policies),
  });
}

function policyRegistry(value: unknown): UploadPolicyRegistry | undefined {
  if (value === undefined) return undefined;
  if (!isUploadPolicyRegistry(value))
    throw new Error(
      'Uploads policies must implement register, originAllowed, verifyCsrf and authorize',
    );
  return value;
}
function policyOwner(value: unknown, registry: unknown): string {
  if (value === undefined) return 'uploads';
  if (
    registry === undefined ||
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9._-]{0,63}$/.test(value)
  )
    throw new Error(
      'Uploads policyOwner must be a lowercase name (a-z0-9._-) used with policies',
    );
  return value;
}

function instrumentation(value: unknown): UploadInstrumentation | undefined {
  if (value === undefined) return undefined;
  if (!isInstrumentation(value))
    throw new Error('Uploads instrumentation must implement start()');
  return value;
}
