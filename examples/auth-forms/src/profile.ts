import { Inject, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Action, Computed, LiveComponent, State } from 'nestvexa';
import type { LiveUpdateContext } from 'nestvexa';
import {
  FORM_ERROR,
  consumeFormState,
  createFormMeta,
  csrfToken,
  errorSummary,
  formView,
  recordSubmit,
  visibleFields,
} from '@nestvexa/forms';
import type { FormErrors, FormMeta } from '@nestvexa/forms';
import { validateField, validateLive } from '@nestvexa/forms/live';
import { UserRepository, VersionConflictError, currentUserId } from './auth.js';
import { profileAdapter, profileFields } from './schemas.js';

const text = (max: number) => ({
  writable: true as const,
  // Transport bound only; the profile schema owns the product rules.
  validate: (value: unknown) =>
    typeof value === 'string' && value.length <= max,
});
export const conflictMessage =
  'This profile was changed in another tab or window. Reload the page to get the latest version before saving.';

/**
 * Profile editor. With JavaScript it is a Live component (per-field validation
 * on blur, submit validation, focus on the first invalid field). Without
 * JavaScript the same markup is an ordinary `POST /profile` form handled by
 * `submitForm`; errors and old input come back through the session.
 */
@LiveComponent({ name: 'profile-editor', view: 'profile-editor' })
export class ProfileEditor {
  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State(text(200)) displayName = '';
  @State(text(400)) email = '';
  @State(text(1000)) bio = '';
  @State() version = 0;
  @State() errors: FormErrors = {};
  @State() form: FormMeta = createFormMeta();
  @State() status = '';

  private userId(): string {
    const id = currentUserId(this.request);
    if (!id || !this.users.find(id)) throw new UnauthorizedException();
    return id;
  }
  mount(): void {
    const user = this.users.find(this.userId());
    if (!user) throw new UnauthorizedException();
    this.displayName = user.displayName;
    this.email = user.email;
    this.bio = user.bio;
    this.version = user.version;
    // Round trip of the no-JavaScript form: read-once errors and old input.
    const previous = consumeFormState(this.request, 'profile');
    if (Object.keys(previous.errors).length) {
      for (const field of profileFields) {
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
    return formView(this.errors, [...profileFields], {
      idPrefix: 'profile-',
      hints: { bio: 'profile-bio-hint' },
      visible: visibleFields(this.form, [...profileFields]),
    });
  }
  @Computed() get summary() {
    return errorSummary(
      this.form.submitted
        ? this.errors
        : { [FORM_ERROR]: this.errors[FORM_ERROR] ?? [] },
      {
        idPrefix: 'profile-',
        labels: { displayName: 'Display name', email: 'Email', bio: 'Bio' },
        order: [...profileFields],
      },
    );
  }
  @Computed() get bioRemaining(): number {
    return 280 - this.bio.length;
  }
  async afterUpdate(update: LiveUpdateContext): Promise<void> {
    this.status = '';
    await validateField(
      this,
      profileAdapter(this.users, this.userId()),
      [...profileFields],
      update.field,
      { metaField: 'form' },
    );
  }
  @Action() async save(): Promise<void> {
    const id = this.userId();
    const result = await validateLive(
      this,
      profileAdapter(this.users, id),
      [...profileFields],
      { metaField: 'form' },
    );
    if (!result.ok) {
      this.status = '';
      return;
    }
    try {
      const saved = this.users.update(id, this.version, result.value);
      this.version = saved.version;
      this.displayName = saved.displayName;
      this.email = saved.email;
      this.bio = saved.bio;
      this.form = createFormMeta();
      this.status = 'Profile saved.';
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      this.errors = { [FORM_ERROR]: [conflictMessage] };
      this.status = '';
    }
  }
}
