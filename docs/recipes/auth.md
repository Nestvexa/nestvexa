# Session sign-in and a Live identity

**Goal:** sign users in with an ordinary server-rendered form, then let only
signed-in users mount and drive a Live component. Authentication stays in your
host; Nestvexa only asks you for an identity and a policy.

Example: [examples/auth-forms](../../examples/auth-forms/README.md) (port 3104).

## 1. Sign in with a hardened form

`submitForm` from `@nestvexa/forms` checks the Origin and CSRF token, validates the
body with your adapter and redirects back with field errors. On success, regenerate
the session (session fixation) and rotate the CSRF token:

<!-- snippet: examples/auth-forms/src/main.ts -->

```ts
// One generic message: never reveal whether the email has an account.
if (!result)
  return {
    errors: { [FORM_ERROR]: ['The email or password is incorrect.'] },
  };
// Session fixation protection: a fresh session id and CSRF token.
await regenerateSession(request);
request.session.userId = result.id;
rotateCsrfToken(request);
return { redirect: '/profile', flash: 'You are signed in.' };
```

## 2. Derive the Live identity from the session

`resolveIdentity` runs on every Live request. Build the binding from server-side
session data only, and include the session id so that signing in or out
invalidates every earlier snapshot. `authorize` is deny-by-default:

<!-- snippet: examples/auth-forms/src/main.ts -->

```ts
          resolveIdentity(request: object) {
            const value = request as Partial<SessionRequest>;
            if (!value.session?.csrf || !value.sessionID)
              throw new UnauthorizedException();
            const user = currentUserId(request);
            // The session id changes on sign-in/out, so earlier snapshots stop matching.
            return {
              binding: `${user ? `user:${user}` : 'guest'}:session:${value.sessionID}`,
              csrfToken: value.session.csrf,
            };
          },
          // Only signed-in identities may mount or drive the profile editor.
          authorize: (identity, component, action) =>
            identity.binding.startsWith('user:') &&
            component === 'profile-editor' &&
            ['$mount', '$sync', 'save'].includes(action),
```

`$mount` and `$sync` are the reserved action names for mounting a component and
for model updates without an action; list them explicitly.

## Security notes

- Never read a user id from the request body or a Live `@State` field: the
  identity comes from the session, and `@Locked` state is not authorization.
- Failed sign-ins return one generic message; the example also throttles and
  blocks an account after five failures and a client address after 30 per
  window (`LoginThrottle` in `src/auth.ts`, process memory only).
- Your guards still run: Live actions are real Nest routes, so a global
  `AuthGuard` or a per-component guard applies as usual.
- Passport works the same way: [examples/auth-passport](../../examples/auth-passport/README.md)
  builds the binding from the Passport session user and its auth version.

## Tests

- [tests/browser/forms.spec.ts](../../tests/browser/forms.spec.ts): registration,
  generic sign-in failures, session regeneration, account lockout and the Live
  profile editor in Chromium, Firefox and WebKit.
- [tests/forms-live.test.ts](../../tests/forms-live.test.ts): Live validation and
  the server-owned error bag.
- [tests/auth-passport.test.ts](../../tests/auth-passport.test.ts): the Passport
  starter.

See also: [forms guide](../guides/forms.md#6-authentication-forms) and
[databases, authentication and multi-tenancy](../guides/auth-and-data.md#authentication-passport-sessions-and-jwt).
