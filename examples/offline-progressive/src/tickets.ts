import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  Action,
  Computed,
  LiveComponent,
  State,
  dispatchLiveEvent,
} from 'nestvexa';
import type { LiveUpdateContext } from 'nestvexa';
import {
  consumeFormState,
  createFormMeta,
  csrfToken,
  errorSummary,
  formView,
  recordSubmit,
  visibleFields,
  zodAdapter,
} from '@nestvexa/forms';
import type { FormErrors, FormMeta } from '@nestvexa/forms';
import { validateField, validateLive } from '@nestvexa/forms/live';
import { z } from 'zod';

export const priorities = ['low', 'normal', 'urgent'] as const;
export type Priority = (typeof priorities)[number];
export interface Ticket {
  readonly id: number;
  readonly subject: string;
  readonly priority: Priority;
  readonly createdAt: string;
}
export const ticketFields = [
  'subject',
  'details',
  'priority',
  'contact',
] as const;

/**
 * One schema for both delivery modes: the Live action and the plain
 * `POST /tickets` route. The contact email is validated but never drafted.
 */
export const ticketAdapter = zodAdapter(
  z.strictObject({
    subject: z
      .string()
      .trim()
      .min(3, 'Enter a subject of at least 3 characters.')
      .max(80, 'Keep the subject to 80 characters.'),
    details: z
      .string()
      .trim()
      .min(10, 'Describe the problem in at least 10 characters.')
      .max(2000, 'Keep the details to 2000 characters.'),
    priority: z.enum(priorities, { error: 'Choose a priority.' }),
    contact: z
      .string()
      .trim()
      .max(254)
      .pipe(z.email('Enter a valid email address.')),
  }),
);
export type TicketInput = {
  subject: string;
  details: string;
  priority: Priority;
  contact: string;
};

/** Demonstration store: per guest session, in process memory, bounded. */
@Injectable()
export class TicketRepository {
  readonly #tickets = new Map<string, Ticket[]>();
  #next = 1;
  list(owner: string): readonly Ticket[] {
    return this.#tickets.get(owner) ?? [];
  }
  add(owner: string, input: TicketInput): Ticket {
    if (!this.#tickets.has(owner) && this.#tickets.size >= 1000)
      this.#tickets.clear();
    const ticket: Ticket = {
      id: this.#next++,
      subject: input.subject,
      priority: input.priority,
      createdAt: new Date().toISOString(),
    };
    this.#tickets.set(owner, [ticket, ...this.list(owner)].slice(0, 20));
    return ticket;
  }
  clear(owner: string): void {
    this.#tickets.delete(owner);
  }
}

export function ownerOf(request: object): string {
  const id: unknown = Reflect.get(request, 'sessionID');
  if (typeof id !== 'string' || !id) throw new UnauthorizedException();
  return `guest-session:${id}`;
}

const text = (max: number) => ({
  writable: true as const,
  // Transport bound only; the schema owns the product rules.
  validate: (value: unknown) =>
    typeof value === 'string' && value.length <= max,
});

/**
 * Support ticket form. With JavaScript it is a Live component; without it the
 * same markup is an ordinary `POST /tickets` form handled by `submitForm`.
 * `@nestvexa/offline` keeps a local draft of the marked fields.
 */
@LiveComponent({ name: 'ticket-form', view: 'ticket-form' })
export class TicketForm {
  constructor(
    @Inject(TicketRepository) private readonly tickets: TicketRepository,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State(text(200)) subject = '';
  @State(text(4000)) details = '';
  @State(text(16)) priority = 'normal';
  @State(text(400)) contact = '';
  @State() errors: FormErrors = {};
  @State() form: FormMeta = createFormMeta();
  @State() status = '';
  /**
   * Epoch milliseconds of the last accepted submit. A changed value clears the
   * local draft; 0 on first render only clears drafts saved before it (none).
   */
  @State() committedAt = 0;

  mount(): void {
    // Round trip of the no-JavaScript form: read-once errors and old input.
    const previous = consumeFormState(this.request, 'ticket');
    if (Object.keys(previous.errors).length) {
      for (const field of ticketFields) {
        const value = previous.old[field];
        if (typeof value === 'string') this[field] = value;
      }
      this.errors = previous.errors;
      this.form = recordSubmit(this.form);
    }
  }
  @Computed() get csrf(): string {
    return csrfToken(this.request);
  }
  @Computed() get fields() {
    return formView(this.errors, [...ticketFields], {
      idPrefix: 'ticket-',
      visible: visibleFields(this.form, [...ticketFields]),
    });
  }
  @Computed() get summary() {
    return errorSummary(this.form.submitted ? this.errors : {}, {
      idPrefix: 'ticket-',
      labels: {
        subject: 'Subject',
        details: 'Details',
        priority: 'Priority',
        contact: 'Contact email',
      },
      order: [...ticketFields],
    });
  }
  @Computed() get priorityOptions() {
    return priorities.map((value) => ({
      value,
      selected: value === this.priority,
    }));
  }
  async afterUpdate(update: LiveUpdateContext): Promise<void> {
    await validateField(this, ticketAdapter, [...ticketFields], update.field, {
      metaField: 'form',
    });
  }
  @Action() async create(): Promise<void> {
    this.status = '';
    const result = await validateLive(this, ticketAdapter, [...ticketFields], {
      metaField: 'form',
    });
    if (!result.ok) return;
    const ticket = this.tickets.add(ownerOf(this.request), result.value);
    this.subject = '';
    this.details = '';
    this.priority = 'normal';
    this.contact = '';
    this.form = createFormMeta();
    this.committedAt = Date.now();
    this.status = `Ticket #${ticket.id} created.`;
    dispatchLiveEvent(this, 'ticket-created', { id: ticket.id });
  }
}
