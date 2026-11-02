import { randomUUID } from 'node:crypto';
import { ActionError } from './errors.js';
import type {
  ActionDefinition,
  ActionDescriptor,
  ActionGroupDefinition,
} from './metadata.js';

/**
 * Principal resolved by the host from verified server-side state (session,
 * token, mTLS). Never derived from the action body.
 */
export interface ActionIdentity {
  /** Stable principal id (user, service account or guest session), 1-512 chars. */
  readonly subject: string;
  /** Tenant/organization boundary, when the host is multi-tenant. */
  readonly tenant?: string;
  /** Per-session CSRF secret compared with the CSRF header (required unless CSRF is disabled). */
  readonly csrfToken?: string;
}

/** Read-only per-request context available through `@ActionContext()`. */
export interface ActionContext {
  readonly requestId: string;
  readonly identity: ActionIdentity;
  readonly action: ActionDescriptor;
  /** Aborted on timeout, client disconnect or application shutdown. */
  readonly signal: AbortSignal;
  /** Validated `Idempotency-Key` for idempotent actions. */
  readonly idempotencyKey: string | undefined;
}

export interface Admission {
  readonly context: ActionContext;
  readonly group: ActionGroupDefinition;
  readonly action: ActionDefinition;
  readonly controller: AbortController;
  readonly input: unknown;
}

// Keyed by the adapter request object; entries disappear with the request.
const admissions = new WeakMap<object, Admission>();
const requestIds = new WeakMap<object, string>();

export function requestIdFor(request: object): string {
  let id = requestIds.get(request);
  if (!id) {
    id = randomUUID();
    requestIds.set(request, id);
  }
  return id;
}

export function admit(request: object, admission: Admission): void {
  admissions.set(request, admission);
}

export function admissionFor(request: object): Admission | undefined {
  return admissions.get(request);
}

export function actionContextFor(request: object): ActionContext {
  const admission = admissions.get(request);
  if (!admission)
    throw new ActionError('INTERNAL', undefined, {
      reason: 'ADMISSION_REQUIRED',
      cause: new Error(
        '@ActionContext/@ActionSignal used outside an admitted ActionsModule route',
      ),
    });
  return admission.context;
}
