---
'@nestvexa/mail': minor
---

Add `@nestvexa/mail`, an optional email and notification bridge that is not part
of the `nestvexa` default install. It renders `emails/<name>.subject|html|text`
templates through the application's view engine (HTML keeps the engine's
escaping; subject and text are plain text and the subject is folded to one line),
validates every message against header injection, malformed addresses, reserved
headers and recipient/body limits, and hands it to a provider-neutral
`MailTransport`: `nodemailerTransport` and `nestMailerTransport`
(`@nestjs-modules/mailer`) bridges typed structurally, a development
`ConsoleMailTransport` and a labeled `MemoryMailTransport` test transport, both
refused in production unless explicitly allowed. `MailModule.forRoot`/
`forRootAsync` provide the `Mailer`; `NotificationBridge` fans notifications out
to mail and realtime channels independently.
