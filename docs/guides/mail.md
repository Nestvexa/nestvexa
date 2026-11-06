# Email and notifications

`@nestvexa/mail` is an optional bridge between your views and the mail integration
you already run. Nestvexa renders and validates; nodemailer, `@nestjs-modules/mailer`
or your provider's API delivers. Nothing here opens SMTP connections or stores
credentials. Package reference: [packages/mail/README.md](../../packages/mail/README.md).

## Recipe: a welcome email

1. Install the package next to your delivery library:

   ```sh
   pnpm add @nestvexa/mail nodemailer
   ```

2. Write the three views. They use the same engine, helpers and escaping as your
   pages:

   ```handlebars
   {{! views/emails/welcome.subject.hbs }}
   Welcome to Example,
   {{name}}
   ```

   ```handlebars
   {{! views/emails/welcome.html.hbs }}
   <h1>Hello {{name}}</h1>
   <p><a href='{{url}}'>Confirm your account</a></p>
   ```

   ```handlebars
   {{! views/emails/welcome.text.hbs }}
   Hello
   {{name}}, confirm your account:
   {{url}}
   ```

   An optional `views/emails/layout.hbs` wraps the HTML part with `{{{body}}}`.
   Your page layout is never applied to mail.

3. Register the module with the application's `HbsEngine` and a transport:

   ```ts
   MailModule.forRootAsync({
     global: true,
     inject: [HbsEngine],
     useFactory: (views: HbsEngine) => ({
       transport:
         process.env['NODE_ENV'] === 'production'
           ? nodemailerTransport(createTransport(process.env['SMTP_URL']))
           : new ConsoleMailTransport(),
       from: { address: 'noreply@example.com', name: 'Example' },
       templates: { renderer: views, layout: 'emails/layout' },
     }),
   });
   ```

4. Send from a service, a controller or a job:

   ```ts
   await mailer.sendTemplate('welcome', {
     to: { address: user.email, name: user.name },
     model: { name: user.name, url },
     locale: user.locale,
   });
   ```

In development the console transport logs the message (with the text part, so
links are clickable in the terminal). Constructed with `NODE_ENV=production` it
throws, so a forgotten production transport fails at boot instead of silently
dropping mail.

## Localized mail

Pass the locale and the `@nestvexa/i18n` helpers per send. The locale is exposed as
`locale` and `i18n.locale`, which is where the i18n helpers read it, so the same
`{{t "mail.welcome"}}` template renders English and Arabic:

```ts
await mailer.sendTemplate('welcome', {
  to: user.email,
  model: { name: user.name },
  locale: user.locale,
  helpers: i18n.helpers(),
});
```

For right-to-left languages pass `i18n: i18n.view(locale)` in the model and use
`<html lang="{{i18n.lang}}" dir="{{i18n.dir}}">` in the mail layout.

## Using `@nestjs-modules/mailer`

If the application already configures `MailerModule`, keep it as the delivery
layer and let Nestvexa render with your views:

```ts
MailModule.forRootAsync({
  inject: [MailerService, HbsEngine],
  useFactory: (mailer: MailerService, views: HbsEngine) => ({
    transport: nestMailerTransport(mailer),
    templates: { renderer: views },
  }),
});
```

## Notifications

`NotificationBridge` sends one typed notification to several channels: templated
mail (`mailChannel`) and a realtime publish (`realtimeChannel`) that refreshes Live
components subscribed to the recipient's channel, for example a notification badge
from the [UI kit](ui-kit.md). Channel authorization stays in the
[realtime](realtime.md) module. Each channel reports `delivered`, `skipped` or
`failed`; one failing channel does not stop the others.

## Security notes

- Subjects and headers can never contain CR/LF: rendered subjects are folded to one
  line and explicit headers with control characters are rejected.
- Model values are escaped in the HTML part by the engine. The text part decodes
  those escapes because it is plain text.
- Do not put secrets in realtime notification payloads: by default only the type is
  published.
- Error messages and `onDelivery` events never include addresses or content.

## Testing

Use `MemoryMailTransport` (a labeled test transport) and assert on
`transport.last()` or `transport.to(address)`. Run your templates through the real
engine in tests, as [the package tests](../../tests/mail.test.ts) do.
