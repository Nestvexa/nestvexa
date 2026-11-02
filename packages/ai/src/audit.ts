import { createHash } from 'node:crypto';
import type { AiAuditEvent, AiAuditSink } from './types.js';

/** Stable pseudonymous subject: the raw identity never enters audit records. */
export function auditSubject(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/** Bounded in-process audit sink for tests and local development. */
export class MemoryAuditSink implements AiAuditSink {
  readonly #events: AiAuditEvent[] = [];
  readonly #limit: number;
  constructor(limit = 1000) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000)
      throw new RangeError('Audit limit must be 1–100000');
    this.#limit = limit;
  }
  get events(): readonly AiAuditEvent[] {
    return Object.freeze([...this.#events]);
  }
  record(event: AiAuditEvent): void {
    this.#events.push(Object.freeze({ ...event }));
    if (this.#events.length > this.#limit) this.#events.shift();
  }
}
