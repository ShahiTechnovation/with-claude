/**
 * Server-side validation for `/api/submit`.
 *
 * The browser's `required` attributes and `type="email"` are a courtesy to the
 * person filling the form in. They are not a check — anything can POST to this
 * endpoint. Everything below re-derives what each form is allowed to contain
 * from `src/data/forms.ts`, so the validator cannot drift from the fields the
 * site actually renders, and rejects everything else.
 *
 * THE REJECTION RULES, AND WHY EACH ONE EXISTS
 *
 *  · UNKNOWN FIELDS ARE REJECTED, not stripped. A submission carrying `status`
 *    or `slug` is not a slightly-wrong submission to be cleaned up; it is
 *    somebody trying to write a field only a reviewer may write, and the
 *    honest response is a 4xx that says so. Silently dropping it would hide an
 *    attempt worth noticing.
 *
 *  · EVERY LENGTH IS BOUNDED. Unbounded text on a public endpoint is a way to
 *    fill a database for free.
 *
 *  · URLS MUST BE HTTPS. A submitted `javascript:` or `http:` link would
 *    eventually be rendered next to somebody's name.
 *
 * Nothing here can set a status, an id, a slug, an entity reference, a
 * reviewer or an approval state. Those are not fields with strict validation —
 * they are fields that do not exist in the input at all.
 */
import { z } from 'zod';
import { forms, type SubmissionForm } from '@/data/forms';

/** Hard ceilings. Generous for a person, useless for a script. */
export const LIMITS = {
  /** Whole request body, before parsing. */
  bodyBytes: 24 * 1024,
  text: 300,
  textarea: 4_000,
  email: 254,
  url: 2_000,
  /** A composed submission has one value per field and no more. */
  fields: 32,
} as const;

/**
 * Fields the client sends that are part of the mechanism rather than the
 * content. They are read, checked, and never stored in the payload.
 */
export const CONTROL_FIELDS = {
  /** Hidden, must stay empty. Named to look worth filling in. */
  honeypot: 'website',
  /** Milliseconds the form was on screen before submitting. */
  elapsed: 'elapsed_ms',
} as const;

/**
 * Fields that may never be accepted from a submitter, listed so the error
 * message can be specific about why.
 *
 * These are not "unknown" fields — they are known fields belonging to the
 * editorial side of the system. A request containing one is answered with a
 * message that says the endpoint does not accept it, rather than a generic
 * shape complaint.
 */
export const RESERVED_FIELDS = [
  'id',
  'slug',
  'status',
  'statusOverride',
  'status_override',
  'featured',
  'entityType',
  'entity_type',
  'entityId',
  'entity_id',
  'reviewer',
  'reviewerId',
  'reviewer_id',
  'reviewerNote',
  'reviewer_note',
  'reviewedAt',
  'reviewed_at',
  'approved',
  'published',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'kind',
  'ipHash',
  'ip_hash',
  'verified',
  'verifiedVia',
  'verified_via',
  'roles',
  'ambassador',
] as const;

/** Which submission kind each form id records. */
const KIND_BY_FORM: Record<string, 'builder' | 'project' | 'use-case' | 'city-interest'> = {
  contribute: 'builder',
  build: 'project',
  practice: 'use-case',
  city: 'city-interest',
};

export type SubmissionKind = (typeof KIND_BY_FORM)[string];

/**
 * An HTTPS URL, bounded and parseable.
 *
 * `http:` is refused rather than upgraded: a link somebody typed as insecure
 * is a link nobody has checked, and quietly rewriting it would make the
 * endpoint responsible for a destination it never saw.
 */
const httpsUrl = z
  .string()
  .trim()
  .max(LIMITS.url, `Links must be under ${LIMITS.url} characters.`)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'That does not look like a full URL.' });
      return;
    }
    if (parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'Links must start with https://' });
    }
  });

/** Build the validator for one form from the fields the site renders. */
function schemaForForm(form: SubmissionForm): z.ZodType<Record<string, string>> {
  const shape: Record<string, z.ZodType> = {};

  for (const field of form.fields) {
    let rule: z.ZodType;

    switch (field.type) {
      case 'email':
        rule = z
          .string()
          .trim()
          .max(LIMITS.email)
          .pipe(z.email('That email address is not valid.'));
        break;
      case 'url':
        rule = httpsUrl;
        break;
      case 'textarea':
        rule = z.string().trim().max(LIMITS.textarea);
        break;
      case 'select':
        // The options the site actually offers, and nothing else. A select is
        // a closed set by definition, so accepting free text here would make
        // it one only in the browser.
        rule = z.enum((field.options ?? []) as [string, ...string[]]);
        break;
      case 'text':
      default:
        rule = z.string().trim().max(LIMITS.text);
        break;
    }

    if (field.required) {
      shape[field.name] =
        field.type === 'select'
          ? rule
          : rule.pipe(z.string().min(1, `${field.label} is required.`));
    } else {
      // An optional field may arrive empty, absent, or filled. Empty and
      // absent mean the same thing and both become absent.
      shape[field.name] = z
        .union([z.literal(''), rule])
        .optional()
        .transform((value) => (value === '' ? undefined : value));
    }
  }

  // `.strict()` is the load-bearing call: an unexpected key fails rather than
  // being dropped.
  return z.strictObject(shape) as unknown as z.ZodType<Record<string, string>>;
}

export interface FormValidator {
  formId: string;
  kind: SubmissionKind;
  schema: z.ZodType<Record<string, string>>;
  /** The field carrying the submitter's email, for acknowledgement. */
  emailField: string;
  /** The field carrying a display name, where the form asks for one. */
  nameField?: string;
}

function emailFieldOf(form: SubmissionForm): string {
  const field = form.fields.find((f) => f.type === 'email');
  if (!field) {
    // Every form must be able to acknowledge itself. A form without an email
    // field is a configuration error, caught at module load rather than at
    // request time.
    throw new Error(`Submission form "${form.id}" has no email field.`);
  }
  return field.name;
}

function nameFieldOf(form: SubmissionForm): string | undefined {
  return form.fields.find((f) => f.name === 'name' || f.name === 'creator')?.name;
}

/** One validator per form the site renders. Built once, at module load. */
export const validators: Map<string, FormValidator> = new Map(
  forms.map((form) => {
    const kind = KIND_BY_FORM[form.id];
    if (!kind) {
      throw new Error(
        `Submission form "${form.id}" has no submission kind. Add it to KIND_BY_FORM — a form ` +
          `the endpoint cannot classify must not be accepted.`,
      );
    }
    return [
      form.id,
      {
        formId: form.id,
        kind,
        schema: schemaForForm(form),
        emailField: emailFieldOf(form),
        nameField: nameFieldOf(form),
      },
    ];
  }),
);

export type ValidationFailure = {
  ok: false;
  status: 400 | 404 | 413 | 422;
  error: string;
  /** Field-level detail, safe to show the person who submitted. */
  issues?: { field: string; message: string }[];
};

export type ValidationSuccess = {
  ok: true;
  validator: FormValidator;
  /** The cleaned payload, retained verbatim as the submission's record. */
  payload: Record<string, string>;
  email: string;
  name?: string;
  /** How long the form was on screen. Undefined when the client did not say. */
  elapsedMs?: number;
};

/**
 * Validate one raw request body.
 *
 * Pure and synchronous, so the whole rule set is testable without a database,
 * a network, or a running server.
 */
export function validateSubmission(raw: unknown): ValidationSuccess | ValidationFailure {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'Expected a JSON object.' };
  }

  const body = { ...(raw as Record<string, unknown>) };

  const formId = body.form;
  delete body.form;

  if (typeof formId !== 'string') {
    return { ok: false, status: 400, error: 'Missing "form".' };
  }

  const validator = validators.get(formId);
  if (!validator) {
    return {
      ok: false,
      status: 404,
      error: `Unknown form "${formId}".`,
    };
  }

  // ── Control fields, read and removed before content validation ────────
  const honeypot = body[CONTROL_FIELDS.honeypot];
  delete body[CONTROL_FIELDS.honeypot];

  const elapsedRaw = body[CONTROL_FIELDS.elapsed];
  delete body[CONTROL_FIELDS.elapsed];

  if (typeof honeypot === 'string' && honeypot.trim().length > 0) {
    // Answered as though it were a real submission. Nothing is stored and
    // nothing is sent, and the caller is not told which check it failed.
    return { ok: false, status: 422, error: 'Submission rejected.' };
  }

  const elapsedMs =
    typeof elapsedRaw === 'number' && Number.isFinite(elapsedRaw)
      ? elapsedRaw
      : typeof elapsedRaw === 'string' && /^\d{1,9}$/.test(elapsedRaw)
        ? Number(elapsedRaw)
        : undefined;

  // ── Fields that belong to the editorial side ──────────────────────────
  const reserved = Object.keys(body).filter((key) =>
    (RESERVED_FIELDS as readonly string[]).includes(key),
  );
  if (reserved.length > 0) {
    return {
      ok: false,
      status: 400,
      error:
        `This endpoint does not accept ${reserved.join(', ')}. A submission is reviewed before ` +
        `anything is published; it cannot set its own state.`,
      issues: reserved.map((field) => ({ field, message: 'Not accepted from a submission.' })),
    };
  }

  if (Object.keys(body).length > LIMITS.fields) {
    return { ok: false, status: 413, error: 'Too many fields.' };
  }

  // Reject non-string values before Zod, so the message is about the shape
  // rather than about thirty individual type errors.
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string') {
      return {
        ok: false,
        status: 400,
        error: `Field "${key}" must be text.`,
        issues: [{ field: key, message: 'Expected text.' }],
      };
    }
  }

  const parsed = validator.schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      error: 'Some fields need attention.',
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        message: issue.message,
      })),
    };
  }

  const payload = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;

  return {
    ok: true,
    validator,
    payload,
    email: payload[validator.emailField]!,
    name: validator.nameField ? payload[validator.nameField] : undefined,
    elapsedMs,
  };
}
