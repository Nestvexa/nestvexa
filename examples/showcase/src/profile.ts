import { Inject, Injectable, Module } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  MemoryDraftStore,
  consumeFormState,
  createDraftManager,
  csrfToken,
  customAdapter,
  defineWizard,
  errorSummary,
  formView,
  zodAdapter,
} from '@nestvexa/forms';
import type { DraftManager, FormErrors, WizardState } from '@nestvexa/forms';
import { readLiveFields } from '@nestvexa/forms/live';
import {
  UploadError,
  UploadsService,
  parseUploadReferences,
  uploadReferenceField,
} from '@nestvexa/uploads';
import { Action, Computed, LiveComponent, State } from 'nestvexa';
import type { LiveUpdateContext } from 'nestvexa';
import { z } from 'zod';
import { ShowcaseData } from './data.js';
import { Directory } from './identity.js';
import type { Access, SessionRequest } from './identity.js';
import { Notifier } from './notify.js';
import { timezones } from './seed.js';
import type { Profile, StoredFile } from './seed.js';

/** The browser client names a purpose `<component>.<field>` for `nv:upload`. */
export const avatarPurpose = 'profile-wizard.avatar';
const digests = ['never', 'daily', 'weekly'] as const;

/**
 * The profile setup wizard: three steps that own disjoint fields, each with
 * its own schema. The same definition serves the Live component and the
 * no-JavaScript POST route; `finish` re-validates every step on the server
 * and never trusts the claimed progress.
 */
export const profileWizard = defineWizard([
  {
    id: 'about',
    title: 'About you',
    fields: ['displayName', 'jobTitle'],
    adapter: zodAdapter(
      z.object({
        displayName: z
          .string()
          .trim()
          .min(2, 'Enter a display name of at least 2 characters.')
          .max(40, 'Keep the display name to 40 characters.'),
        jobTitle: z
          .string()
          .trim()
          .max(60, 'Keep the job title to 60 characters.'),
      }),
    ),
  },
  {
    id: 'preferences',
    title: 'Preferences',
    fields: ['timezone', 'digest'],
    adapter: zodAdapter(
      z.object({
        timezone: z.enum(timezones, {
          message: 'Choose a time zone from the list.',
        }),
        digest: z.enum(digests, { message: 'Choose how often we email you.' }),
      }),
    ),
  },
  {
    id: 'photo',
    title: 'Photo',
    fields: ['avatar'],
    // The upload itself is validated by @nestvexa/uploads at finalize time.
    adapter: customAdapter((input) => ({
      avatar: typeof input['avatar'] === 'string' ? input['avatar'] : '',
    })),
  },
]);
export const profileFields = [
  'displayName',
  'jobTitle',
  'timezone',
  'digest',
] as const;
const labels = {
  displayName: 'Display name',
  jobTitle: 'Job title',
  timezone: 'Time zone',
  digest: 'Email notifications',
  avatar: 'Photo',
};

/**
 * Server-side drafts (with the user's explicit consent) through
 * @nestvexa/forms' DraftManager: version-checked, size-bounded, 7-day TTL.
 * Process memory here; a database or Redis store in production.
 */
export const DRAFTS = Symbol('profile-drafts');
@Module({
  providers: [
    {
      provide: DRAFTS,
      useValue: createDraftManager({ store: new MemoryDraftStore() }),
    },
  ],
  exports: [DRAFTS],
})
export class DraftsModule {}

export type ProfileValues = Record<(typeof profileFields)[number], string>;
/** No-JavaScript progress, kept in the server session between POSTs. */
export interface ProfileFlow {
  readonly state: WizardState;
  readonly values: ProfileValues;
}
declare module 'express-session' {
  interface SessionData {
    profileFlow?: ProfileFlow;
  }
}

export function initialValues(
  profile: Profile | undefined,
  fallbackName: string,
): ProfileValues {
  return {
    displayName: profile?.displayName ?? fallbackName,
    jobTitle: profile?.jobTitle ?? '',
    timezone: profile?.timezone ?? 'UTC',
    digest: profile?.digest ?? 'weekly',
  };
}

/** Saves the finished profile and sends the confirmation notification. */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(ShowcaseData) private readonly data: ShowcaseData,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}
  async complete(
    access: Access,
    values: Record<string, unknown>,
    avatar: StoredFile | undefined,
  ): Promise<void> {
    const text = (name: string) => {
      const value = values[name];
      return typeof value === 'string' ? value.trim() : '';
    };
    const digest = text('digest');
    const previous = this.data.profile(access.user.id);
    const avatarFile = avatar ?? previous?.avatar;
    this.data.saveProfile(access.user.id, {
      displayName: text('displayName'),
      jobTitle: text('jobTitle'),
      timezone: text('timezone'),
      digest: digest === 'never' || digest === 'daily' ? digest : 'weekly',
      ...(avatarFile ? { avatar: avatarFile } : {}),
      completedAt: new Date().toISOString(),
    });
    await this.notifier.notify(access.user, {
      type: 'profile.completed',
      data: {
        summary: 'Your profile is complete.',
        digest: digest || 'weekly',
      },
    });
  }
}

const text = (max: number) => (value: unknown) =>
  typeof value === 'string' && value.length <= max;

/** `/app/profile`: the multi-step wizard with consented server-side autosave. */
@LiveComponent({ name: 'profile-wizard', view: 'profile-wizard' })
export class ProfileWizard {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(ShowcaseData) private readonly data: ShowcaseData,
    @Inject(DRAFTS) private readonly drafts: DraftManager,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(ProfileService) private readonly profiles: ProfileService,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State({ writable: true, validate: text(200) }) displayName = '';
  @State({ writable: true, validate: text(200) }) jobTitle = '';
  @State({ writable: true, validate: text(40) }) timezone = 'UTC';
  @State({ writable: true, validate: text(20) }) digest = 'weekly';
  @State({ writable: true, validate: uploadReferenceField({ max: 1 }) })
  avatar = '';
  /** The user's explicit opt-in to server-side drafts (forms refuses saves without it). */
  @State({ writable: true, validate: (value) => typeof value === 'boolean' })
  autosave = false;
  @State() wizard: WizardState = profileWizard.initial();
  @State() errors: FormErrors = {};
  @State() draftVersion = 0;
  @State() draftStatus = '';
  @State() completed = false;
  @State() hasAvatar = false;

  #access(): Access {
    return this.directory.require(this.request);
  }
  #owner(): string {
    return `user:${this.#access().user.id}`;
  }
  #apply(values: Partial<Record<string, unknown>>): void {
    for (const field of profileFields) {
      const value = values[field];
      if (typeof value === 'string') this[field] = value;
    }
  }
  async mount(): Promise<void> {
    const access = this.#access();
    const profile = this.data.profile(access.user.id);
    this.hasAvatar = profile?.avatar !== undefined;
    this.#apply(initialValues(profile, access.user.name));
    const session = (this.request as SessionRequest).session;
    // Progress and errors of the no-JavaScript path (read-once errors).
    if (session.profileFlow) {
      this.wizard = session.profileFlow.state;
      this.#apply(session.profileFlow.values);
      const previous = consumeFormState(this.request, 'profile');
      this.#apply(previous.old);
      this.errors = previous.errors;
      return;
    }
    const draft = await this.drafts.load(this.#owner(), 'profile');
    if (
      draft &&
      typeof draft.value === 'object' &&
      draft.value !== null &&
      !Array.isArray(draft.value)
    ) {
      this.#apply(draft.value);
      this.draftVersion = draft.version;
      this.autosave = true;
      this.draftStatus = `Restored your saved draft (version ${draft.version}).`;
    }
  }
  @Computed() get csrf(): string {
    return csrfToken(this.request);
  }
  @Computed() get step() {
    return profileWizard.position(this.wizard);
  }
  @Computed() get steps() {
    const current = profileWizard.position(this.wizard).index;
    return profileWizard.steps.map((step, index) => ({
      id: step.id,
      title: step.title,
      number: index + 1,
      current: index === current,
      done: this.wizard.completed.includes(step.id),
      reachable: index <= this.wizard.completed.length,
    }));
  }
  @Computed() get fields() {
    return formView(this.errors, [...profileFields, 'avatar'], {
      idPrefix: 'profile-',
    });
  }
  @Computed() get summary() {
    return errorSummary(this.errors, {
      idPrefix: 'profile-',
      labels,
      order: [...profileFields, 'avatar'],
    });
  }
  @Computed() get timezoneOptions() {
    return timezones.map((value) => ({
      value,
      selected: value === this.timezone,
    }));
  }
  @Computed() get digestOptions() {
    return digests.map((value) => ({ value, selected: value === this.digest }));
  }
  @Computed() get onAbout(): boolean {
    return this.step.id === 'about';
  }
  @Computed() get onPreferences(): boolean {
    return this.step.id === 'preferences';
  }
  @Computed() get onPhoto(): boolean {
    return this.step.id === 'photo';
  }
  #values(): Record<string, unknown> {
    return readLiveFields(this, [...profileFields, 'avatar']);
  }
  /** Autosave: every accepted field change is stored when the user opted in. */
  async afterUpdate(update: LiveUpdateContext): Promise<void> {
    if (update.field === 'autosave' && !this.autosave) {
      await this.drafts.discard(this.#owner(), 'profile');
      this.draftVersion = 0;
      this.draftStatus = 'Autosave is off. Your saved draft was deleted.';
      return;
    }
    if (
      update.field === 'autosave' ||
      (profileFields as readonly string[]).includes(update.field)
    )
      await this.#saveDraft();
  }
  async #saveDraft(): Promise<void> {
    if (!this.autosave) return;
    const values = readLiveFields(this, [...profileFields]);
    const result = await this.drafts.save(this.#owner(), 'profile', values, {
      expectedVersion: this.draftVersion,
      consent: this.autosave,
    });
    if (result.ok) {
      this.draftVersion = result.version;
      this.draftStatus = `Draft saved (version ${result.version}).`;
    } else if (result.reason === 'conflict')
      this.draftStatus =
        'A newer draft was saved in another tab. Reload this page to continue from it; nothing was overwritten.';
    else this.draftStatus = 'The draft could not be saved.';
  }
  @Action() async saveDraft(): Promise<void> {
    this.autosave = true;
    await this.#saveDraft();
  }
  @Action() async discardDraft(): Promise<void> {
    await this.drafts.discard(this.#owner(), 'profile');
    this.autosave = false;
    this.draftVersion = 0;
    this.draftStatus = 'Draft deleted.';
  }
  @Action() async next(): Promise<void> {
    const result = await profileWizard.next(this.wizard, this.#values());
    this.errors = result.errors;
    this.wizard = result.state;
  }
  @Action() back(): void {
    this.errors = {};
    this.wizard = profileWizard.back(this.wizard);
  }
  @Action() async finish(): Promise<void> {
    const result = await profileWizard.finish(this.wizard, this.#values());
    if (!result.ok) {
      this.errors = result.errors;
      this.wizard = result.state;
      return;
    }
    let avatar: StoredFile | undefined;
    const [token] = parseUploadReferences(this.avatar, 1);
    if (token) {
      try {
        const file = await this.uploads.finalize(this.request, token, {
          purpose: avatarPurpose,
        });
        avatar = {
          key: file.key,
          name: file.name,
          contentType: file.contentType,
          size: file.size,
          sha256: file.sha256,
        };
      } catch (error) {
        this.avatar = '';
        if (!(error instanceof UploadError)) throw error;
        this.errors = { avatar: [`The photo was refused (${error.code}).`] };
        return;
      }
    }
    await this.profiles.complete(this.#access(), result.value, avatar);
    await this.drafts.discard(this.#owner(), 'profile');
    delete (this.request as SessionRequest).session.profileFlow;
    this.avatar = '';
    this.hasAvatar = this.hasAvatar || avatar !== undefined;
    this.autosave = false;
    this.draftVersion = 0;
    this.draftStatus = '';
    this.errors = {};
    this.completed = true;
    this.wizard = profileWizard.initial();
  }
}
