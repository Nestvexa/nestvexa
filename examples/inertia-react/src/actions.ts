import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Req,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import {
  ActionContext,
  ActionError,
  ActionGroup,
  ActionInput,
  ActionsModule,
  ServerAction,
} from '@nestvexa/actions';
import { InertiaPage } from '@nestvexa/inertia';
import type { NoteBoard } from './page-types.js';

// Typed server actions called from an Inertia page: `scripts/codegen.mjs`
// generates client/generated/actions-client{,.react}.{js,d.ts} from this
// group, and Features/Actions uses the generated `useNotesAdd()` hook.

export interface AddNoteInput {
  text: string;
}

interface SessionRequest {
  readonly session?: { readonly id?: string; readonly xsrf?: string };
}

const MAX_BOARDS = 1000;

/** Per-session notes, bounded and process-local (demo storage). */
@Injectable()
export class NoteBoards {
  readonly #boards = new Map<string, string[]>();

  get(owner: string): NoteBoard {
    const notes = this.#boards.get(owner) ?? [];
    return { total: notes.length, latest: notes.slice(0, 5) };
  }

  add(owner: string, text: string): NoteBoard {
    let notes = this.#boards.get(owner);
    if (!notes) {
      if (this.#boards.size >= MAX_BOARDS) throw ActionError.rateLimited();
      notes = [];
      this.#boards.set(owner, notes);
    }
    notes.unshift(text);
    notes.length = Math.min(notes.length, 50);
    return this.get(owner);
  }
}

@Module({ providers: [NoteBoards], exports: [NoteBoards] })
export class NotesModule {}

/** The session-bound identity actions run as (and the page reads). */
function owner(request: object): string | undefined {
  const id = (request as SessionRequest).session?.id;
  return id ? `inertia-example:session:${id}` : undefined;
}

@ActionGroup('notes')
export class NotesActions {
  constructor(@Inject(NoteBoards) private readonly boards: NoteBoards) {}

  @ServerAction({ id: 'add' })
  add(
    @ActionInput() input: AddNoteInput,
    @ActionContext() context: ActionContext,
  ): NoteBoard {
    const text =
      typeof input === 'object' &&
      input !== null &&
      typeof input.text === 'string'
        ? input.text.trim()
        : '';
    if (text.length === 0 || text.length > 60)
      throw ActionError.validation(undefined, [
        { path: ['text'], message: 'Enter 1-60 characters.' },
      ]);
    if (text === 'fail')
      throw ActionError.validation(undefined, [
        { path: ['text'], message: 'The server rejected this note.' },
      ]);
    return this.boards.add(context.identity.subject, text);
  }
}

@Controller('features')
export class ActionsPageController {
  constructor(@Inject(NoteBoards) private readonly boards: NoteBoards) {}

  /** Server-rendered with the current board; the hook takes it as initial data. */
  @Get('actions')
  @InertiaPage('Features/Actions')
  page(@Req() request: object): { board: NoteBoard } {
    const subject = owner(request);
    return {
      board: subject ? this.boards.get(subject) : { total: 0, latest: [] },
    };
  }
}

/**
 * The actions endpoint (`POST /_nestvexa/actions/notes/add`). Identity is the
 * host session and the CSRF token is the session's XSRF token, which the page
 * reads from the `XSRF-TOKEN` cookie like the official Inertia client.
 */
export function noteActions(origin: string): DynamicModule {
  return ActionsModule.register({
    groups: [NotesActions],
    imports: [NotesModule],
    origin,
    resolveIdentity: (request) => {
      const subject = owner(request);
      const csrfToken = (request as SessionRequest).session?.xsrf;
      return subject && csrfToken ? { subject, csrfToken } : null;
    },
    authorize: (_identity, action) => action.group === 'notes',
  });
}
