---
'@nestvexa/mail': patch
---

`nodemailerTransport` is now verified with a real nodemailer SMTP transporter
against an in-process SMTP server (delivery, recipient rejection, unreachable
server, greeting timeout and header-injection refusal before any connection);
the README and mail guide document the remaining gaps (`nestMailerTransport`
against a real `MailerService`, TLS and SMTP authentication) and recommend
transporter timeouts.
