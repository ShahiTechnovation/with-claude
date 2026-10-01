/**
 * BASEROW, OVER HTTP, WITH NOTHING LEFT TO CHANCE.
 *
 * Two callers use this module and they hold different credentials:
 *
 *   - the SYNC SERVICE, with a read token, pulling whole tables
 *   - the IMPORT CLI, with a separate write token, creating and patching rows
 *
 * Neither should ever have to think about transport. Everything that can go
 * wrong between here and `api.baserow.io` is handled once, in this file, and
 * surfaces as one typed `BaserowError` with a `kind` the caller can branch on.
 *
 * ── WHAT THIS FILE PROMISES ──────────────────────────────────────────────
 *
 *  1. THE TOKEN GOES IN ONE PLACE: the `Authorization: Token …` header. Never
 *     a URL (URLs end up in logs, proxies and error messages), never an error
 *     message. Every message that leaves this module passes through `redact`.
 *
 *  2. URLS ARE BUILT FROM INTEGERS, NOT STRINGS. Table and row ids are checked
 *     to be positive safe integers before a path is assembled, so `'1; DROP'`
 *     or `'../../users'` is refused before a single byte goes on the wire.
 *
 *  3. FIELDS ARE ADDRESSED BY ID. Rows are keyed `field_<id>`, and
 *     `user_field_names` is deliberately never sent. A column rename in the
 *     Baserow UI must not silently re-map our data.
 *
 *  4. A FAILED REQUEST IS RETRIED ONLY WHEN RETRYING CAN HELP. Network errors,
 *     timeouts, 429 and 500/502/503/504 are retried with bounded exponential
 *     backoff and full jitter. 400/401/403/404 are answers, not accidents, and
 *     retrying them only multiplies the noise.
 *
 *  5. CONCURRENCY IS BOUNDED PER CLIENT. Baserow Cloud documents a limit of 10
 *     concurrent API requests per account. We default to 4 and refuse to go
 *     above 8, so a burst from the sync service cannot starve the import CLI
 *     (or the other way round) into a wall of 429s.
 *
 *  6. A RESPONSE IS NOT TRUSTED BECAUSE IT WAS A 200. Every body is validated
 *     against its expected shape. A 200 that is the wrong shape is
 *     `invalid-response`, which is the failure mode that otherwise looks like
 *     an empty table.
 *
 *  7. "ALL ROWS" MEANS ALL ROWS. `listAllRows` reports `complete: true` only
 *     when every page arrived and the distinct row count matches `count`. A
 *     page that fails is rethrown — a partial table returned as if it were the
 *     whole table is how a sync quietly deletes data.
 */
import { z } from 'zod';

/* ───────────────────────────── errors ───────────────────────────── */

export type BaserowErrorKind =
  | 'auth'
  | 'not-found'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid-response'
  | 'bad-request';

export class BaserowError extends Error {
  readonly kind: BaserowErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  /**
   * How long the server asked us to wait, from `Retry-After`. Only set for
   * `rate-limited`, and already capped. Internal to the retry loop, but
   * harmless to expose.
   */
  readonly retryAfterMs?: number;

  constructor(
    kind: BaserowErrorKind,
    message: string,
    details: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    // Belt and braces: whatever the caller built, secrets are stripped here too.
    super(stripSecrets(message));
    this.name = 'BaserowError';
    this.kind = kind;
    this.status = details.status;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs;
  }
}

/* ──────────────────────────── redaction ─────────────────────────── */

/** The longest body excerpt any error message may carry. */
const MAX_EXCERPT_CHARS = 200;

const REDACTED = '[redacted]';

/**
 * Strip anything that looks like a credential, then bound the length.
 *
 * Three shapes are caught:
 *
 *   - an auth scheme followed by a value (`Token abc…`, `Bearer …`, `JWT …`)
 *   - a credential-ish query parameter (`token=…`, `key=…`, `secret=…`)
 *   - a long opaque string mixing letters AND digits, which is what a Baserow
 *     database token (32 random alphanumerics) and most API keys look like,
 *     plus anything shaped like a JWT
 *
 * The letters-and-digits rule is what keeps Baserow's own error codes
 * (`ERROR_REQUEST_BODY_VALIDATION`, all letters and underscores) readable
 * while still catching a token that has been echoed back.
 *
 * Redaction happens BEFORE truncation, so a token straddling the 200-char cut
 * cannot survive as a recognisable prefix.
 */
export function redact(text: string): string {
  const scrubbed = stripSecrets(text);
  return scrubbed.length > MAX_EXCERPT_CHARS ? `${scrubbed.slice(0, MAX_EXCERPT_CHARS)}…` : scrubbed;
}

/**
 * `redact` without the length bound. Used for whole error messages, which
 * are ours and may legitimately run past 200 characters; anything inside them
 * that came from a server has already been through `redact` proper.
 */
function stripSecrets(text: string): string {
  return String(text)
    .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, REDACTED)
    .replace(/\b(Token|Bearer|JWT|Basic)\s+[^\s"',;]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/\b(token|access_token|api_key|apikey|key|secret|password)=([^&\s"']+)/gi, `$1=${REDACTED}`)
    .replace(/[A-Za-z0-9_-]{20,}/g, (match) => (/\d/.test(match) && /[A-Za-z]/.test(match) ? REDACTED : match));
}

/* ──────────────────────────── options ───────────────────────────── */

export interface BaserowClientOptions {
  /** Defaults to Baserow Cloud. Must be https (http only for localhost). */
  baseUrl?: string;
  /** A Baserow DATABASE token. Sent as `Authorization: Token <token>`. */
  token: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per ATTEMPT, not per call. Default 8000. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 4, so at most 5 attempts. */
  maxRetries?: number;
  /** In-flight requests per client. Default 4, hard cap 8. */
  maxConcurrency?: number;
  /** Injected in tests so backoff costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so jitter is deterministic. Must return [0, 1). */
  random?: () => number;
}

export const DEFAULT_BASE_URL = 'https://api.baserow.io';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_CONCURRENCY = 4;
/** Baserow Cloud allows 10. Eight leaves headroom for anything else on the account. */
const MAX_CONCURRENCY = 8;
/** Baserow's documented ceiling for `size`. */
export const MAX_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 500;
/** First backoff step, doubled per attempt. */
const BACKOFF_BASE_MS = 250;
/** No single backoff sleep is longer than this. */
const BACKOFF_CAP_MS = 10_000;
/** A server-provided `Retry-After` is honoured up to here, and no further. */
const RETRY_AFTER_CAP_MS = 30_000;

/* ───────────────────────────── shapes ───────────────────────────── */

/**
 * A row is an object with a numeric `id`. Everything else is `field_<id>`
 * keys whose value types depend on the field type, so they stay `unknown`
 * here and are interpreted by the caller that knows the table's schema.
 */
const rowSchema = z.looseObject({ id: z.number().int() });

const pageSchema = z.object({
  count: z.number().int().nonnegative(),
  next: z.string().nullable(),
  previous: z.string().nullable(),
  results: z.array(rowSchema),
});

const fieldSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  type: z.string(),
  primary: z.boolean().optional(),
});

const fieldsSchema = z.array(fieldSchema);

export type BaserowRow = z.infer<typeof rowSchema>;
export type BaserowField = z.infer<typeof fieldSchema>;
export type BaserowRowsPage = z.infer<typeof pageSchema>;

/** A write body. Keys are field ids, never names. */
export type BaserowFieldValues = Readonly<Record<`field_${number}`, unknown>>;

export interface ListAllRowsOptions {
  /** Default 200, Baserow's maximum. */
  pageSize?: number;
  /** Runaway guard. Default 500 pages. Hitting it yields `complete: false`. */
  maxPages?: number;
  /** Called after each page arrives, before the next is requested. */
  onPage?: (info: { page: number; rows: readonly BaserowRow[]; count: number }) => void | Promise<void>;
}

export interface ListAllRowsResult {
  rows: BaserowRow[];
  /** True only if every page was fetched AND the distinct row count equals `count`. */
  complete: boolean;
  pages: number;
}

export interface BaserowClient {
  listRowsPage(tableId: number, page: number, size?: number): Promise<BaserowRowsPage>;
  listAllRows(tableId: number, options?: ListAllRowsOptions): Promise<ListAllRowsResult>;
  getRow(tableId: number, rowId: number): Promise<BaserowRow>;
  createRow(tableId: number, fields: BaserowFieldValues): Promise<BaserowRow>;
  updateRow(tableId: number, rowId: number, fields: BaserowFieldValues): Promise<BaserowRow>;
  deleteRow(tableId: number, rowId: number): Promise<void>;
  listFields(tableId: number): Promise<BaserowField[]>;
}

/* ──────────────────────────── validation ────────────────────────── */

/**
 * The only way a value reaches a URL path. `unknown` on purpose: the type
 * system says `number`, but this is the line that holds when a caller casts.
 */
function assertId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new BaserowError('bad-request', `Baserow ${label} must be a positive integer.`);
  }
  return value;
}

function assertPageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new BaserowError('bad-request', `Baserow page size must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return value;
}

/**
 * Refuse a write body keyed by anything other than `field_<id>`. Baserow
 * ignores keys it does not recognise, so a body keyed by field NAMES would
 * "succeed" while writing nothing — exactly the silent failure to prevent.
 */
function assertFieldValues(fields: unknown): Record<string, unknown> {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new BaserowError('bad-request', 'Baserow row fields must be an object.');
  }
  for (const key of Object.keys(fields)) {
    if (!/^field_[1-9]\d*$/.test(key)) {
      throw new BaserowError('bad-request', `Baserow row fields must be keyed field_<id>; got "${key.slice(0, 40)}".`);
    }
  }
  return fields as Record<string, unknown>;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * https, always — the token is a bearer credential. Plain http is allowed
 * only for a loopback host, which is what a local test server is. Userinfo,
 * query and fragment are refused because none has a legitimate use in a base
 * URL and each is a place a credential could hide.
 */
function normaliseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BaserowError('bad-request', 'Baserow baseUrl is not a valid URL.');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new BaserowError('bad-request', 'Baserow baseUrl must use https (http is allowed only for localhost).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new BaserowError('bad-request', 'Baserow baseUrl must not carry credentials, a query or a fragment.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** A token with whitespace or control characters could split the header. */
function assertToken(token: unknown): string {
  if (typeof token !== 'string' || token.length === 0 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new BaserowError('auth', 'Baserow token is missing or malformed.');
  }
  return token;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/* ──────────────────────────── concurrency ───────────────────────── */

/**
 * A counting semaphore. A released slot is handed directly to the next
 * waiter rather than freed and re-contended, so the in-flight count can never
 * overshoot `max`, even for a tick.
 */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/* ──────────────────────────── classification ────────────────────── */

const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Either way the
 * answer is capped: a misbehaving proxy saying "come back in an hour" must
 * not park a cron invocation until it is killed.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, Math.round(ms)));
}

/**
 * A short, safe description of an error body. Baserow answers errors as
 * `{ "error": "ERROR_CODE", "detail": … }`, and the code is the useful part;
 * anything else is reduced to a redacted, truncated excerpt.
 */
function excerpt(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const { error, detail } = parsed as { error?: unknown; detail?: unknown };
      const parts = [typeof error === 'string' ? error : '', typeof detail === 'string' ? detail : ''];
      const joined = parts.filter(Boolean).join(': ');
      if (joined) return redact(joined);
    }
  } catch {
    /* not JSON — fall through to the raw excerpt */
  }
  return redact(body.slice(0, MAX_EXCERPT_CHARS * 4).replace(/\s+/g, ' ').trim());
}

/** Turn a non-2xx response into the error it means. */
function classifyStatus(status: number, label: string, body: string, retryAfter: string | null): BaserowError {
  const detail = excerpt(body);
  const message = `Baserow ${label} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`;

  if (status === 401 || status === 403) return new BaserowError('auth', message, { status });
  if (status === 404) return new BaserowError('not-found', message, { status });
  if (status === 429) {
    return new BaserowError('rate-limited', message, {
      status,
      retryable: true,
      retryAfterMs: parseRetryAfter(retryAfter),
    });
  }
  if (status >= 500) {
    return new BaserowError('server', message, { status, retryable: RETRYABLE_SERVER_STATUSES.has(status) });
  }
  if (status >= 400) return new BaserowError('bad-request', message, { status });
  // A 1xx/3xx reaching us is not something this API sends. Redirects are not
  // followed (see `redirect: 'manual'`), so this is where one lands.
  return new BaserowError('invalid-response', message, { status });
}

/** Anything thrown by `fetch` itself becomes a retryable network error. */
function asTransportError(error: unknown, label: string): BaserowError {
  if (error instanceof BaserowError) return error;
  const reason = redact(error instanceof Error ? error.message : String(error));
  return new BaserowError('network', `Baserow ${label} could not reach the server: ${reason}`, { retryable: true });
}

/* ───────────────────────────── client ───────────────────────────── */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface RequestSpec {
  method: Method;
  /** Path below the base URL, assembled only from validated integers. */
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  /** Human label for messages: method + path, which never holds a secret. */
  label: string;
}

/** What one attempt yields on success: parsed JSON, or nothing for 204. */
type AttemptResult = { ok: true; json: unknown };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createBaserowClient(options: BaserowClientOptions): BaserowClient {
  const token = assertToken(options.token);
  const baseUrl = normaliseBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch: typeof fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000);
  const maxRetries = clampInt(options.maxRetries, DEFAULT_MAX_RETRIES, 0, 10);
  const concurrency = clampInt(options.maxConcurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const limit = createLimiter(concurrency);

  /**
   * The exact token string is scrubbed as well as the generic patterns, so a
   * server that echoes the header back verbatim cannot get it into a message
   * even if the token happens not to match the heuristics in `redact`.
   */
  const scrub = (error: BaserowError): BaserowError => {
    if (!error.message.includes(token)) return error;
    return new BaserowError(error.kind, error.message.split(token).join(REDACTED), {
      status: error.status,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    });
  };

  const buildUrl = (spec: RequestSpec): string => {
    const query = spec.query ? `?${new URLSearchParams(spec.query).toString()}` : '';
    return `${baseUrl}${spec.path}${query}`;
  };

  /**
   * Full jitter: a uniformly random delay in [0, base·2^attempt), capped.
   * A server-provided `Retry-After` wins over the computed delay, because the
   * server knows when it will have capacity and we do not.
   */
  const delayFor = (error: BaserowError, attempt: number): number => {
    if (error.retryAfterMs !== undefined) return error.retryAfterMs;
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.floor(random() * ceiling);
  };

  /**
   * One attempt, under the semaphore and under its own timeout. The timeout
   * covers reading the body as well as the headers — a server that sends
   * headers promptly and then stalls is still a timeout.
   *
   * The abort is raced as well as signalled, so a `fetch` that ignores its
   * signal still cannot hold a slot past `timeoutMs`.
   */
  const attempt = (spec: RequestSpec): Promise<AttemptResult> =>
    limit(async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new BaserowError('timeout', `Baserow ${spec.label} timed out after ${timeoutMs}ms.`, { retryable: true }),
          );
        }, timeoutMs);
      });

      const exchange = async (): Promise<AttemptResult> => {
        let response: Response;
        try {
          response = await doFetch(buildUrl(spec), {
            method: spec.method,
            headers: {
              Authorization: `Token ${token}`,
              Accept: 'application/json',
              ...(spec.body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: spec.body ? JSON.stringify(spec.body) : undefined,
            signal: controller.signal,
            // Never follow a redirect with a credential attached.
            redirect: 'manual',
          });
        } catch (error) {
          throw asTransportError(error, spec.label);
        }

        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          throw asTransportError(error, spec.label);
        }

        if (response.status < 200 || response.status > 299) {
          throw classifyStatus(response.status, spec.label, text, response.headers.get('retry-after'));
        }
        if (response.status === 204 || text.trim() === '') return { ok: true, json: undefined };

        try {
          return { ok: true, json: JSON.parse(text) as unknown };
        } catch {
          throw new BaserowError('invalid-response', `Baserow ${spec.label} returned a body that is not JSON.`, {
            status: response.status,
          });
        }
      };

      try {
        return await Promise.race([exchange(), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    });

  /** Attempts, classification and backoff. Throws the last classified error. */
  const send = async (spec: RequestSpec): Promise<unknown> => {
    for (let tries = 0; ; tries += 1) {
      try {
        const result = await attempt(spec);
        return result.json;
      } catch (thrown) {
        const error = scrub(asTransportError(thrown, spec.label));
        if (!error.retryable || tries >= maxRetries) throw error;
        await sleep(delayFor(error, tries));
      }
    }
  };

  /** Validation is not retried: the same server will send the same wrong shape. */
  const parse = <S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
      throw new BaserowError('invalid-response', `Baserow ${label} returned an unexpected shape${where}.`);
    }
    return result.data;
  };

  const rowsPath = (tableId: number): string => `/api/database/rows/table/${tableId}/`;
  const rowPath = (tableId: number, rowId: number): string => `/api/database/rows/table/${tableId}/${rowId}/`;

  const listRowsPage = async (tableId: number, page: number, size: number = MAX_PAGE_SIZE): Promise<BaserowRowsPage> => {
    const table = assertId(tableId, 'table id');
    const pageNumber = assertId(page, 'page number');
    const pageSize = assertPageSize(size);
    const path = rowsPath(table);
    const label = `GET ${path} page ${pageNumber}`;
    const json = await send({
      method: 'GET',
      path,
      query: { page: String(pageNumber), size: String(pageSize) },
      label,
    });
    return parse(pageSchema, json, label);
  };

  /**
   * Page numbers are computed here, not read from `next`. `next` is an
   * absolute URL chosen by the server, and following it blindly would send
   * the token to whatever host it names.
   *
   * Termination: an empty page, or `page × size ≥ count`. Completeness is the
   * stricter test — distinct ids equal to the LAST page's `count` — so a table
   * that gained or lost rows mid-walk (which shifts rows across page
   * boundaries) is reported as incomplete rather than trusted.
   */
  const listAllRows = async (tableId: number, opts: ListAllRowsOptions = {}): Promise<ListAllRowsResult> => {
    const table = assertId(tableId, 'table id');
    const pageSize = assertPageSize(opts.pageSize ?? MAX_PAGE_SIZE);
    const maxPages = clampInt(opts.maxPages, DEFAULT_MAX_PAGES, 1, Number.MAX_SAFE_INTEGER);
    const rows: BaserowRow[] = [];
    let lastCount = 0;

    for (let page = 1; ; page += 1) {
      if (page > maxPages) return { rows, complete: false, pages: page - 1 };

      // Any throw here propagates. There is no partial result to return.
      const result = await listRowsPage(table, page, pageSize);
      lastCount = result.count;
      rows.push(...result.results);
      await opts.onPage?.({ page, rows: result.results, count: result.count });

      if (result.results.length === 0 || page * pageSize >= result.count) {
        const distinct = new Set(rows.map((row) => row.id)).size;
        const complete = distinct === rows.length && rows.length === lastCount;
        return { rows, complete, pages: page };
      }
    }
  };

  const getRow = async (tableId: number, rowId: number): Promise<BaserowRow> => {
    const path = rowPath(assertId(tableId, 'table id'), assertId(rowId, 'row id'));
    const label = `GET ${path}`;
    return parse(rowSchema, await send({ method: 'GET', path, label }), label);
  };

  const createRow = async (tableId: number, fields: BaserowFieldValues): Promise<BaserowRow> => {
    const path = rowsPath(assertId(tableId, 'table id'));
    const body = assertFieldValues(fields);
    const label = `POST ${path}`;
    return parse(rowSchema, await send({ method: 'POST', path, body, label }), label);
  };

  const updateRow = async (tableId: number, rowId: number, fields: BaserowFieldValues): Promise<BaserowRow> => {
    const path = rowPath(assertId(tableId, 'table id'), assertId(rowId, 'row id'));
    const body = assertFieldValues(fields);
    const label = `PATCH ${path}`;
    return parse(rowSchema, await send({ method: 'PATCH', path, body, label }), label);
  };

  const deleteRow = async (tableId: number, rowId: number): Promise<void> => {
    const path = rowPath(assertId(tableId, 'table id'), assertId(rowId, 'row id'));
    await send({ method: 'DELETE', path, label: `DELETE ${path}` });
  };

  /**
   * Field listing is where a mis-scoped token shows up first: a database
   * token without read permission on the table answers 401/403 here. That is
   * a CONFIGURATION problem, not a transient one, and the message says so.
   */
  const listFields = async (tableId: number): Promise<BaserowField[]> => {
    const path = `/api/database/fields/table/${assertId(tableId, 'table id')}/`;
    const label = `GET ${path}`;
    try {
      return parse(fieldsSchema, await send({ method: 'GET', path, label }), label);
    } catch (error) {
      if (error instanceof BaserowError && error.kind === 'auth') {
        throw new BaserowError(
          'auth',
          `Baserow configuration error: the token cannot list fields for table ${tableId} (HTTP ${error.status ?? '?'}). ` +
            'Check that it is a database token with read access to this table.',
          { status: error.status },
        );
      }
      throw error;
    }
  };

  return { listRowsPage, listAllRows, getRow, createRow, updateRow, deleteRow, listFields };
}
