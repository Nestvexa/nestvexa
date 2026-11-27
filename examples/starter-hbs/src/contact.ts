import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  Query,
  Render,
  Res,
} from '@nestjs/common';

/**
 * Server-side validation for the starter's contact form. The form is a plain
 * HTML POST, so it works without JavaScript; browser `required`/`maxlength`
 * attributes are hints only and every rule is enforced here.
 */
export interface ContactValues {
  readonly name: string;
  readonly email: string;
  readonly message: string;
}
export type ContactField = keyof ContactValues;
export type ContactErrors = Partial<Record<ContactField, string>>;
export type ContactResult =
  | { readonly ok: true; readonly values: ContactValues }
  | {
      readonly ok: false;
      readonly values: ContactValues;
      readonly errors: ContactErrors;
    };

export const contactLimits = { name: 80, email: 254, message: 1000 } as const;
const fields: readonly ContactField[] = ['name', 'email', 'message'];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Read one urlencoded field; arrays and objects (`name[]=x`) are refused, not coerced. */
function field(body: unknown, name: ContactField): string | undefined {
  if (!body || typeof body !== 'object') return '';
  const value: unknown = Object.getOwnPropertyDescriptor(body, name)?.value;
  if (value === undefined) return '';
  return typeof value === 'string' ? value.trim() : undefined;
}

export function validateContact(body: unknown): ContactResult {
  const errors: ContactErrors = {};
  const read = new Map<ContactField, string>();
  for (const name of fields) {
    const value = field(body, name);
    read.set(name, value ?? '');
    if (value === undefined) errors[name] = 'Send this field once, as text.';
    else if (value.length > contactLimits[name])
      errors[name] = `Use at most ${contactLimits[name]} characters.`;
  }
  const values: ContactValues = {
    name: read.get('name') ?? '',
    email: read.get('email') ?? '',
    message: read.get('message') ?? '',
  };
  if (!errors.name && !values.name) errors.name = 'Enter your name.';
  if (!errors.email && !emailPattern.test(values.email))
    errors.email = 'Enter an email address such as name@example.com.';
  if (!errors.message && !values.message) errors.message = 'Enter a message.';
  return Object.keys(errors).length
    ? { ok: false, values, errors }
    : { ok: true, values };
}

/**
 * The starter has no session or cookies, so a forged cross-site POST carries
 * no credentials; refusing foreign `Origin` headers still keeps other sites
 * from submitting through a visitor's browser. Add a CSRF token (see the
 * forms guide) as soon as the app has sessions.
 */
export function sameOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined) return true;
  return host !== undefined && origin === `http://${host}`;
}

/** The response methods the POST route uses (Express provides them). */
interface FormResponse {
  status(code: number): unknown;
  redirect(status: number, url: string): void;
  render(view: string, locals: object): void;
}

/**
 * Progressive-enhancement form: a plain POST that works without JavaScript.
 * Invalid input re-renders the form with 422 and field errors; success
 * redirects with 303 so reloading the result page does not resubmit.
 */
@Controller('contact')
export class ContactController {
  @Get()
  @Render('contact')
  form(@Query('sent') sent?: string) {
    return {
      title: 'Contact',
      sent: sent === '1',
      values: { name: '', email: '', message: '' },
      errors: {},
      limits: contactLimits,
    };
  }

  @Post()
  submit(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Headers('host') host: string | undefined,
    @Res() response: FormResponse,
  ): void {
    if (!sameOrigin(origin, host))
      throw new ForbiddenException('Cross-origin form submission');
    const result = validateContact(body);
    if (result.ok) {
      // A real application stores or sends result.values here.
      response.redirect(303, '/contact?sent=1');
      return;
    }
    response.status(422);
    response.render('contact', {
      title: 'Contact: fix the errors',
      sent: false,
      values: result.values,
      errors: result.errors,
      invalid: true,
      limits: contactLimits,
    });
  }
}
