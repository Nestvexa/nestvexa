# @nestvexa/mail

Optional email and notification bridge for Nestvexa: render subject, HTML and
plain-text templates with the view engine your application already uses, validate
the message, and hand it to the mail integration you already run. It is **not**
part of the default `nestvexa` install and it is **not** a mail provider: it never
opens SMTP connections or holds credentials.

Alpha software; consult the root release blockers before production use.

## Install

```sh
npm install @nestvexa/mail
pnpm add @nestvexa/mail
yarn add @nestvexa/mail
```

Peers: `@nestjs/common` 12, `reflect-metadata` 0.2, `rxjs` 7.8. Node 22.13+ or 24,
ESM (with a `default` export condition for CommonJS hosts). No runtime
dependencies; the view engine and the delivery library are supplied by the host.

## Templates

Each mail is three views under `views/emails/` (the directory is configurable):

```text
views/emails/welcome.subject.hbs   Welcome, {{name}}
views/emails/welcome.html.hbs      <h1>Hello {{name}}</h1><p><a href="{{url}}">Confirm</a></p>
views/emails/welcome.text.hbs      Hello {{name}}. Confirm: {{url}}
views/emails/layout.hbs            optional HTML layout, receives {{{body}}}
```

`MailTemplates` renders them through any object with
`render(view, model, options)`: the `HbsEngine` from `nestvexa`/`@nestvexa/engine-hbs`,
or the EJS, Pug and Nunjucks adapters. Rules:

- **HTML** keeps the engine's escaping (`{{name}}` is escaped, `{{{raw}}}` is not).
  The application's page layout is never applied; set `layout: 'emails/layout'`
  for a mail layout.
- **Text and subject** are plain text, so the entities the engine produced
  (`&amp;`, `&lt;`, `&#x27;` ...) are decoded before sending. Text is never
  rendered as HTML by mail clients, so this is not an injection path.
- **Subject** is folded to one line (all whitespace runs, including CR/LF and
  U+2028, become one space), so a model value can never start a new header. A
  remaining control character fails with `INVALID_HEADER`.
- `text: 'derive'` (globally or per render) generates the text part from the HTML
  instead of a `.text` view: links become `label (href)`, list items `- item`,
  head/style/script are dropped. The converter is a single linear scan.
- `locale` is exposed as `locale` and `i18n.locale`, which is where
  `@nestvexa/i18n` helpers read it. Pass the helpers per render:
  `{ locale: 'ar', helpers: i18n.helpers() }`.
- Template names are lowercase path segments (`invoice/paid`); anything else is
  refused with `TEMPLATE_FAILED`.

## Module

```ts
import { Module } from '@nestjs/common';
import { HbsEngine } from 'nestvexa';
import {
  ConsoleMailTransport,
  MailModule,
  nodemailerTransport,
} from '@nestvexa/mail';
import { createTransport } from 'nodemailer';

@Module({
  imports: [
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
    }),
  ],
})
export class AppModule {}
```

```ts
@Injectable()
export class SignupService {
  constructor(@Inject(Mailer) private readonly mailer: Mailer) {}
  async welcome(user: { email: string; name: string; locale: string }) {
    await this.mailer.sendTemplate('welcome', {
      to: { address: user.email, name: user.name },
      model: { name: user.name, url: confirmUrl(user) },
      locale: user.locale,
    });
  }
}
```

`Mailer.send(message)` sends an already rendered message. Both return
`{ id, transport, message }`. `onDelivery` receives ids, counts, the template name
and a closed error code only (no addresses or content); a throwing hook is ignored.

## Transports

| Transport                      | Use                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `nodemailerTransport(t)`       | A nodemailer `Transporter` you configured (SMTP, SES, ...). Typed structurally, no dependency.        |
| `nestMailerTransport(service)` | `@nestjs-modules/mailer`'s `MailerService` (inject it in `forRootAsync`); Nestvexa renders, it sends. |
| `ConsoleMailTransport`         | Development: logs a summary and the text part through the Nest `Logger` (bcc counted, HTML omitted).  |
| `MemoryMailTransport`          | **Test transport**: keeps messages for assertions (`last()`, `to(address)`, `byId(id)`), bounded.     |
| your own `MailTransport`       | `{ name, send(message): Promise<{ id }> }` for an HTTP API provider.                                  |

`ConsoleMailTransport` and `MemoryMailTransport` deliver nothing; they throw
`UNSAFE_ENVIRONMENT` when constructed with `NODE_ENV=production` unless
`allowProduction: true` is passed, because silently swallowing mail or logging
reset links in production is a defect.

## Message validation

`normalizeMailMessage` (run by `Mailer` for every send) enforces:

- addresses: `local@domain.tld`, dot-atom local parts only (no quoted local parts,
  comments, IP literals or `Name <addr>` strings; use `{ address, name }`);
- CR, LF, NUL, other C0 controls, DEL and U+2028/U+2029 are rejected in the
  subject, display names and extra headers (header injection);
- extra header names are tokens; address, subject, date, message id and MIME
  headers are reserved for the typed fields; duplicates are rejected;
- at most 50 recipients (to + cc + bcc), 20 extra headers and 2 MiB of body by
  default (`limits`), checked before the HTML is converted to text;
- display names are quoted and escaped when formatted for providers.

Errors are `MailError` with a closed `code` and a message that names the field,
never its value.

## Notifications

```ts
const notifications = new NotificationBridge<User>([
  mailChannel<User>(mailer, {
    address: (user) => user.email,
    locale: (user) => user.locale,
  }),
  realtimeChannel<User>(realtime, {
    channel: (user) => `user:${user.id}:notifications`,
  }),
]);
await notifications.notify(user, { type: 'invoice.paid', data: { amount } });
```

`mailChannel` renders the template named after the type (`invoice/paid`).
`realtimeChannel` publishes `{ type }` (or your `payload`) through any object with
`publish(channel, data)`, such as `RealtimeService` from `@nestvexa/realtime`;
channel authorization stays in the realtime module. Channels run independently and
report `delivered`, `skipped` or `failed` (with a closed code) per channel, so a
mail outage does not drop the realtime update.

## Caveats

- No attachments, inline images or calendar parts yet; send those through your
  provider directly.
- Queueing and retries belong to your job system (`JobRunner` in
  `@nestvexa/realtime`, BullMQ, ...): call `Mailer.send` from the job.
- The address check is deliberately stricter than RFC 5322; internationalized
  (non-ASCII) addresses are rejected.

## Testing

`tests/mail.test.ts` renders real HBS templates (escaping, layouts, derived text,
Arabic and English with `@nestvexa/i18n` helpers), wires `MailModule` with
`@nestjs/testing`, and covers the transports and the notification bridge.
`tests/mail-security.test.ts` covers header injection, reserved headers, address
validation, limits and the production refusal of non-delivering transports.
