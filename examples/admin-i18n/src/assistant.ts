import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AiAssistant, AiError, TestProvider, defineTool } from '@nestvexa/ai';
import type { AiAssistantOptions, AiConversationView } from '@nestvexa/ai';
import { I18n } from '@nestvexa/i18n';
import type { I18nView } from '@nestvexa/i18n';
import {
  Action,
  Computed,
  LiveComponent,
  Locked,
  State,
  dispatchLiveEvent,
} from 'nestvexa';
import { Catalog, seedName } from './catalog.js';
import { binding } from './identity.js';

const longReport = Array.from(
  { length: 12 },
  (_, index) =>
    `Section ${index + 1}: the catalog has steady demand, balanced categories and no pricing anomalies in this scripted sample.`,
).join(' ');

/**
 * Deterministic, clearly labeled TEST provider. It replays scripted text and
 * never calls a model; see packages/ai/README.md to connect a real provider.
 */
export function assistantOptions(catalog: Catalog): AiAssistantOptions {
  const archiveProduct = defineTool<{ id: string }>({
    name: 'archiveProduct',
    description: 'Archive one active product in the catalog by id',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    parse(input) {
      const id: unknown =
        input && typeof input === 'object' && !Array.isArray(input)
          ? Reflect.get(input, 'id')
          : undefined;
      if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id))
        throw new Error('Invalid product id');
      return { id };
    },
    summarize: ({ id }) => `archiveProduct("${seedName(id)}")`,
    // Re-checked by AiAssistant when the model asks and again on approval.
    authorize: (identity, { id }) =>
      catalog.find(identity, id)?.status === 'active',
    execute: ({ id }, { identity }) => {
      catalog.archive(identity, id);
      return `Archived ${id}`;
    },
  });
  return {
    provider: new TestProvider({
      chunkDelayMs: 40,
      wordsPerChunk: 2,
      rules: [
        {
          match: /archive/i,
          reply:
            'I found “Desk lamp” (lamp). Archiving changes the catalog, so I need your approval first.',
          toolCall: { name: 'archiveProduct', arguments: { id: 'lamp' } },
          afterTool: 'Done. “Desk lamp” is archived and no longer active.',
        },
        {
          match: /أرشف/,
          reply:
            'وجدت «Desk lamp» (lamp). الأرشفة تغيّر الكتالوج، لذا أحتاج إلى موافقتك أولًا.',
          toolCall: { name: 'archiveProduct', arguments: { id: 'lamp' } },
          afterTool: 'تم. أصبح «Desk lamp» مؤرشفًا ولم يعد نشطًا.',
        },
        { match: /long report|تقرير/i, reply: longReport },
      ],
      fallback:
        'This test provider only knows two scripted requests: archiving the desk lamp and writing a long report.',
    }),
    tools: [archiveProduct],
    timeoutMs: 20_000,
  };
}

/**
 * Assistant panel. The conversation lives server-side in AiAssistant, bound to
 * the identity; the snapshot only carries locked ids. Approval acts on the call
 * the server showed (`shownCallId`), never on a browser-supplied id.
 */
@LiveComponent({ name: 'assistant-panel', view: 'assistant-panel' })
export class AssistantPanel {
  constructor(
    @Inject(AiAssistant) private readonly ai: AiAssistant,
    @Inject(Catalog) private readonly catalog: Catalog,
    @Inject(I18n) private readonly translations: I18n,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @Locked() @State() conversationId = '';
  @Locked() @State() shownCallId = '';
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 4000,
  })
  prompt = '';
  /** AiError code of the last refused request, translated at render time. */
  @State() error = '';

  mount(): void {
    this.conversationId = this.ai.open(binding(this.request));
  }
  @Computed() get i18n(): I18nView {
    return this.translations.forRequest(this.request).view;
  }
  @Computed() get chat(): AiConversationView {
    return this.ai.view(binding(this.request), this.conversationId);
  }
  @Computed() get turnId(): string {
    return `${this.conversationId}:${this.chat.turn}`;
  }
  @Computed() get messages() {
    const context = this.translations.forRequest(this.request);
    return this.chat.messages.map((message) => ({
      id: message.id,
      role: message.role,
      who: context.t(
        `assistant:${message.role === 'user' ? 'you' : message.role}`,
      ),
      text:
        message.role === 'tool' && message.toolStatus
          ? context.t(`assistant:toolStatus.${message.toolStatus}`)
          : message.text,
      incomplete: message.incomplete,
    }));
  }
  @Computed() get pending() {
    const pending = this.chat.pending;
    return pending && pending.callId === this.shownCallId ? pending : null;
  }
  @Computed() get testProvider(): boolean {
    return this.chat.provider.kind === 'test';
  }
  /**
   * Server-rendered outcome of the last turn, so the announcement survives the
   * re-render that follows `collect` (the browser glue sets the live text
   * while streaming).
   */
  @Computed() get statusText(): string {
    const chat = this.chat;
    if (chat.status !== 'idle' && chat.status !== 'failed') return '';
    const key =
      chat.lastOutcome === 'completed'
        ? 'done'
        : chat.lastOutcome === 'cancelled'
          ? 'cancelled'
          : chat.lastOutcome === 'timeout' || chat.lastOutcome === 'failed'
            ? 'failed'
            : '';
    return key
      ? this.translations.forRequest(this.request).t(`assistant:${key}`)
      : '';
  }
  @Computed() get errorMessage(): string {
    return this.error
      ? this.translations
          .forRequest(this.request)
          .t(`assistant:errors.${this.error}`)
      : '';
  }
  private refused(error: unknown): void {
    if (!(error instanceof AiError)) throw error;
    this.error = ['PROMPT', 'BUSY', 'APPROVAL', 'CONVERSATION'].includes(
      error.code,
    )
      ? error.code
      : 'BUSY';
  }
  @Action() ask(): void {
    try {
      this.ai.ask(binding(this.request), this.conversationId, this.prompt);
      this.prompt = '';
      this.error = '';
    } catch (error) {
      this.refused(error);
    }
  }
  /** Called once by the browser glue after each stream settles. */
  @Action() async collect(): Promise<void> {
    const owner = binding(this.request);
    // A stopped stream may still be closing server-side; wait (bounded) so the
    // partial reply is visible in this render.
    await this.ai.settled(owner, this.conversationId);
    this.shownCallId =
      this.ai.view(owner, this.conversationId).pending?.callId ?? '';
  }
  @Action() async approve(): Promise<void> {
    const owner = binding(this.request);
    try {
      const result = await this.ai.approve(
        owner,
        this.conversationId,
        this.shownCallId,
      );
      this.error = '';
      const latest = this.catalog.activity(owner)[0];
      if (result.status === 'executed' && latest?.kind === 'archived') {
        dispatchLiveEvent(this, 'product-archived', { id: latest.productId });
        dispatchLiveEvent(this, 'toast', {
          message: this.translations
            .forRequest(this.request)
            .t('products:archived', { name: latest.name }),
          tone: 'success',
        });
      }
    } catch (error) {
      this.refused(error);
    } finally {
      this.shownCallId = '';
    }
  }
  @Action() reject(): void {
    try {
      this.ai.reject(
        binding(this.request),
        this.conversationId,
        this.shownCallId,
      );
      this.error = '';
    } catch (error) {
      this.refused(error);
    } finally {
      this.shownCallId = '';
    }
  }
}
