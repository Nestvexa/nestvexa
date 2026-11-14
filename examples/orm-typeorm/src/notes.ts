import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Render,
  Req,
} from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  ActionContext,
  ActionError,
  ActionGroup,
  ActionInput,
  ServerAction,
} from '@nestvexa/actions';
import { Action, Computed, LiveComponent, LiveRuntime, State } from 'nestvexa';
import { createHash, randomBytes } from 'node:crypto';
import type { Session, SessionData } from 'express-session';

/*
 * ORM-neutral application code, byte-identical in examples/orm-prisma,
 * examples/orm-typeorm and examples/orm-drizzle (tests/orm-examples.test.ts
 * checks it). Only src/database.ts differs: it implements `NotesStore` with
 * one ORM. Nestvexa never sees the ORM; components, actions and pages receive
 * the store through ordinary Nest dependency injection.
 */

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
export interface SessionRequest {
  session: Session & Partial<SessionData>;
  sessionID: string;
}

export interface Note {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  /** ISO 8601 timestamp. */
  readonly createdAt: string;
}
/** The persistence port every ORM implements in src/database.ts. */
export interface NotesStore {
  /** Newest first, at most `limit` notes. */
  list(limit: number): Promise<Note[]>;
  add(note: { author: string; body: string }): Promise<Note>;
  count(): Promise<number>;
}
export const NOTES_STORE = Symbol('NOTES_STORE');

export const MAX_NOTE_LENGTH = 280;
const PAGE_SIZE = 20;

/** 1-280 characters after trimming; returns an error message or undefined. */
export function noteError(body: string): string | undefined {
  if (body.length === 0) return 'Write something first.';
  if (body.length > MAX_NOTE_LENGTH)
    return `Keep notes to ${MAX_NOTE_LENGTH} characters.`;
  return undefined;
}

/** The session's CSRF token, created on first use. */
export function csrfOf(request: SessionRequest): string {
  request.session.csrf ??= randomBytes(32).toString('base64url');
  return request.session.csrf;
}
/**
 * The author name comes from the server-side session, never from the request
 * body: a short, stable pseudonym derived from the session id.
 */
export function authorOf(request: object): string {
  const id: unknown = Reflect.get(request, 'sessionID');
  if (typeof id !== 'string' || id.length === 0)
    throw new BadRequestException('Missing session');
  return `visitor-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
}

/** Live: the board reads through the store on every render and writes on `add`. */
@LiveComponent({ name: 'note-board', view: 'note-board' })
export class NoteBoard {
  constructor(
    @Inject(NOTES_STORE) private readonly store: NotesStore,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State({
    writable: true,
    validate: (value: unknown) =>
      typeof value === 'string' && value.length <= MAX_NOTE_LENGTH * 2,
  })
  draft = '';
  @State() error = '';
  @State() message = '';

  @Computed({ async: true })
  async notes(): Promise<Note[]> {
    return this.store.list(PAGE_SIZE);
  }
  @Computed({ async: true })
  async total(): Promise<number> {
    return this.store.count();
  }
  @Action()
  async add(): Promise<void> {
    const body = this.draft.trim();
    const error = noteError(body);
    this.error = error ?? '';
    this.message = '';
    if (error) return;
    const note = await this.store.add({
      author: authorOf(this.request),
      body,
    });
    this.draft = '';
    this.message = `Note #${note.id} saved.`;
  }
}

/** Action input: one bounded string field, unknown fields dropped. */
@Injectable()
export class NoteInputPipe implements PipeTransform<unknown, { body: string }> {
  transform(value: unknown): { body: string } {
    const body: unknown =
      value && typeof value === 'object' && !Array.isArray(value)
        ? Reflect.get(value, 'body')
        : undefined;
    if (typeof body !== 'string') throw ActionError.validation();
    const trimmed = body.trim();
    const error = noteError(trimmed);
    if (error)
      throw ActionError.validation(error, [{ path: ['body'], message: error }]);
    return { body: trimmed };
  }
}

/** Server actions: the same store behind a typed JSON endpoint. */
@Injectable()
@ActionGroup('notes')
export class NotesActions {
  constructor(@Inject(NOTES_STORE) private readonly store: NotesStore) {}
  @ServerAction({ id: 'list' })
  async list(): Promise<{ notes: Note[]; total: number }> {
    return {
      notes: await this.store.list(PAGE_SIZE),
      total: await this.store.count(),
    };
  }
  @ServerAction({ id: 'add', concurrency: 'serial' })
  add(
    @ActionInput(NoteInputPipe) input: { body: string },
    @ActionContext() context: ActionContext,
  ): Promise<Note> {
    // The author is the host-resolved subject, never a client field.
    return this.store.add({
      author: context.identity.subject,
      body: input.body,
    });
  }
}

export const csp =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** MVC: an ordinary Nest controller rendering an HBS page from the store. */
@Controller()
export class PagesController {
  constructor(
    @Inject(NOTES_STORE) private readonly store: NotesStore,
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  async home(@Req() request: SessionRequest) {
    csrfOf(request);
    const notes = await this.store.list(5);
    return {
      title: 'Notes',
      latest: notes,
      board: await this.live.mount(NoteBoard, request),
    };
  }
  @Get('api/health')
  async health() {
    return { status: 'ok', notes: await this.store.count() };
  }
}
