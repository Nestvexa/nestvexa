export { MailError, type MailErrorCode } from './errors.js';
export {
  assertHeaderText,
  decodeHtmlEntities,
  formatMailbox,
  htmlToText,
  isMailAddress,
  normalizeMailMessage,
  type MailAddress,
  type MailLimits,
  type MailMailbox,
  type MailMessage,
  type MailRecipients,
  type NormalizedMailMessage,
} from './message.js';
export {
  MailTemplates,
  type MailRenderOptions,
  type MailTemplatesOptions,
  type MailViewHelper,
  type MailViewRenderer,
  type RenderedMail,
} from './templates.js';
export {
  ConsoleMailTransport,
  MemoryMailTransport,
  nestMailerTransport,
  nodemailerTransport,
  toSendMailOptions,
  type ConsoleMailTransportOptions,
  type MailLog,
  type MailSendResult,
  type MailTransport,
  type MemoryMailTransportOptions,
  type SendMailOptions,
  type SendMailTarget,
} from './transports.js';
export {
  MAIL_OPTIONS,
  MailModule,
  Mailer,
  type MailDelivery,
  type MailDeliveryEvent,
  type MailModuleAsyncOptions,
  type MailModuleOptions,
  type TemplateMail,
} from './mailer.js';
export {
  NotificationBridge,
  mailChannel,
  realtimeChannel,
  type MailChannelOptions,
  type Notification,
  type NotificationChannel,
  type NotificationResult,
  type RealtimeChannelOptions,
  type RealtimePublisher,
} from './notifications.js';
