import { describe, expect, it, vi } from 'vitest';
import {
  BaserowError,
  createBaserowClient,
  parseRetryAfter,
  redact,
  type BaserowClientOptions,
} from '../src/server/integrations/baserow/client';

/**
 * The Baserow client, exercised against a fake `fetch`.
 *
 * Nothing here touches the network. Each test hands the client a scripted
 * server and asserts on two things: what the client SENT (URL, method,
 * headers) and what it SURFACED (rows, or a classified `BaserowError`).
 *
 * The promises worth guarding are the ones whose failure is silent:
 *
 *   - the token leaking into a URL or an error message
 *   - a partial table being reported as the whole table
 *   - retries that hammer a server which already said no
 *   - a burst of calls exceeding Baserow's concurrency limit
 *
 * Backoff uses an injected `sleep`, so a test of five retries takes no time
 * and the delays it asked for can be asserted exactly.
 */

/** Shaped like a real database token: 32 letters and digits. */
const TOKEN = 'Zq8RkT2vLm5Xc9Np3Hw7Jd4Fs6Gb1Ya0E';
const BASE = 'https://api.baserow.io';

interface Call {
  url: string;
  init: RequestInit;
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: impl as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, overrides: Partial<BaserowClientOptions> = {}) {
  return createBaserowClient({
    token: TOKEN,
    fetch: fetchImpl,
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  });
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

/** Await a rejection and hand back the `BaserowError`, failing if it is anything else. */
async function caught(promise: Promise<unknown>): Promise<BaserowError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BaserowError);
    return error as BaserowError;
  }
  throw new Error('expected the call to reject');
}

const row = (id: number) => ({ id, order: '1.00000000000000000000', field_101: `row ${id}` });

describe('requests', () => {
  it('sends the token in the Authorization header and never in the URL', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(row(7)));
    const result = await client(fetch).getRow(12, 7);

    expect(result.id).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/database/rows/table/12/7/`);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(header(calls[0].init, 'authorization')).toBe(`Token ${TOKEN}`);
    expect(calls[0].init.method).toBe('GET');
  });

  it('never asks for user field names', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ count: 0, next: null, previous: null, results: [] }));
    await client(fetch).listRowsPage(3, 1, 50);
    expect(calls[0].url).toBe(`${BASE}/api/database/rows/table/3/?page=1&size=50`);
    expect(calls[0].url).not.toContain('user_field_names');
  });

  it('writes with JSON bodies keyed by field id, using the right verbs', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse(row(9)),
    );
    const c = client(fetch);

    await c.createRow(4, { field_101: 'hello' });
    await c.updateRow(4, 9, { field_102: true });
    await c.deleteRow(4, 9);

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      `POST ${BASE}/api/database/rows/table/4/`,
      `PATCH ${BASE}/api/database/rows/table/4/9/`,
      `DELETE ${BASE}/api/database/rows/table/4/9/`,
    ]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ field_101: 'hello' });
    expect(header(calls[0].init, 'content-type')).toBe('application/json');
  });

  it('refuses a write body keyed by field names, before any fetch', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(row(1)));
    const error = await caught(
      client(fetch).createRow(4, { Name: 'x' } as unknown as Record<`field_${number}`, unknown>),
    );
    expect(error.kind).toBe('bad-request');
    expect(calls).toHaveLength(0);
  });

  it.each([-1, 0, 1.5, Number.NaN, '1; DROP', '../users'])(
    'rejects table id %s before any fetch',
    async (bad) => {
      const { fetch, calls } = fakeFetch(() => jsonResponse(row(1)));
      const c = client(fetch);
      const id = bad as unknown as number;

      for (const call of [
        () => c.getRow(id, 1),
        () => c.listRowsPage(id, 1),
        () => c.listAllRows(id),
        () => c.listFields(id),
        () => c.createRow(id, { field_1: 'x' }),
        () => c.deleteRow(id, 1),
      ]) {
        const error = await caught(call());
        expect(error.kind).toBe('bad-request');
        expect(error.retryable).toBe(false);
      }
      // And as a row id, too.
      expect((await caught(c.getRow(1, id))).kind).toBe('bad-request');
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses a page size above 200', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(row(1)));
    expect((await caught(client(fetch).listRowsPage(1, 1, 201))).kind).toBe('bad-request');
    expect(calls).toHaveLength(0);
  });
});

describe('configuration', () => {
  it('accepts https, and http only for loopback', () => {
    const { fetch } = fakeFetch(() => jsonResponse(row(1)));
    expect(() => client(fetch, { baseUrl: 'https://baserow.example.org/' })).not.toThrow();
    expect(() => client(fetch, { baseUrl: 'http://127.0.0.1:8080' })).not.toThrow();
    expect(() => client(fetch, { baseUrl: 'http://localhost:3000' })).not.toThrow();
    expect(() => client(fetch, { baseUrl: 'http://baserow.example.org' })).toThrow(BaserowError);
    expect(() => client(fetch, { baseUrl: 'ftp://baserow.example.org' })).toThrow(BaserowError);
    expect(() => client(fetch, { baseUrl: 'https://user:pass@baserow.example.org' })).toThrow(BaserowError);
    expect(() => client(fetch, { baseUrl: 'not a url' })).toThrow(BaserowError);
  });

  it('keeps a self-hosted path prefix', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(row(2)));
    await client(fetch, { baseUrl: 'http://localhost:8000/baserow/' }).getRow(1, 2);
    expect(calls[0].url).toBe('http://localhost:8000/baserow/api/database/rows/table/1/2/');
  });

  it('refuses an empty or header-splitting token', () => {
    const { fetch } = fakeFetch(() => jsonResponse(row(1)));
    expect(() => client(fetch, { token: '' })).toThrow(BaserowError);
    expect(() => client(fetch, { token: 'abc\r\nX-Evil: 1' })).toThrow(BaserowError);
  });
});

describe('pagination', () => {
  const table = [row(1), row(2), row(3), row(4), row(5)];

  function pagedServer(count = table.length) {
    return fakeFetch((call) => {
      const url = new URL(call.url);
      const page = Number(url.searchParams.get('page'));
      const size = Number(url.searchParams.get('size'));
      const results = table.slice((page - 1) * size, page * size);
      // `next` points somewhere hostile on purpose: the client must not follow it.
      const next = page * size < count ? `https://evil.example/steal?page=${page + 1}` : null;
      return jsonResponse({ count, next, previous: null, results });
    });
  }

  it('walks three pages of two and reports five rows as complete', async () => {
    const { fetch, calls } = pagedServer();
    const pages: number[] = [];
    const result = await client(fetch).listAllRows(10, {
      pageSize: 2,
      onPage: ({ page }) => {
        pages.push(page);
      },
    });

    expect(result.complete).toBe(true);
    expect(result.pages).toBe(3);
    expect(result.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/api/database/rows/table/10/?page=1&size=2`,
      `${BASE}/api/database/rows/table/10/?page=2&size=2`,
      `${BASE}/api/database/rows/table/10/?page=3&size=2`,
    ]);
    expect(calls.every((c) => c.url.startsWith(BASE))).toBe(true);
  });

  it('reports an empty table as complete after one request', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ count: 0, next: null, previous: null, results: [] }));
    const result = await client(fetch).listAllRows(10);
    expect(result).toEqual({ rows: [], complete: true, pages: 1 });
    expect(calls).toHaveLength(1);
  });

  it('is incomplete when the rows received do not add up to count', async () => {
    // The server claims 7 rows but runs dry after 5.
    const { fetch } = pagedServer(7);
    const result = await client(fetch).listAllRows(10, { pageSize: 2 });
    expect(result.rows).toHaveLength(5);
    expect(result.complete).toBe(false);
  });

  it('stops at maxPages and says it is incomplete', async () => {
    const { fetch, calls } = pagedServer();
    const result = await client(fetch).listAllRows(10, { pageSize: 2, maxPages: 2 });
    expect(result.complete).toBe(false);
    expect(result.pages).toBe(2);
    expect(result.rows).toHaveLength(4);
    expect(calls).toHaveLength(2);
  });

  it('rethrows a mid-walk failure instead of returning a partial table', async () => {
    const { fetch, calls } = fakeFetch((call) => {
      const page = Number(new URL(call.url).searchParams.get('page'));
      if (page === 2) return jsonResponse({ error: 'ERROR_INVALID_ACCESS_TOKEN' }, 401);
      return jsonResponse({ count: 5, next: 'x', previous: null, results: [row(1), row(2)] });
    });
    const error = await caught(client(fetch).listAllRows(10, { pageSize: 2 }));
    expect(error.kind).toBe('auth');
    expect(error.status).toBe(401);
    expect(calls).toHaveLength(2);
  });
});

describe('retries', () => {
  it('honours Retry-After on a 429, then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0
        ? jsonResponse({ error: 'ERROR_REQUEST_LIMIT' }, 429, { 'Retry-After': '3' })
        : jsonResponse(row(5)),
    );
    const result = await client(fetch, { sleep }).getRow(1, 5);

    expect(result.id).toBe(5);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('caps a huge Retry-After at 30 seconds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const { fetch } = fakeFetch((_call, index) =>
      index === 0 ? jsonResponse({}, 429, { 'Retry-After': '3600' }) : jsonResponse(row(5)),
    );
    await client(fetch, { sleep }).getRow(1, 5);
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it('parses Retry-After as seconds or as an HTTP date', () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    expect(parseRetryAfter('2', now)).toBe(2000);
    expect(parseRetryAfter('Fri, 02 Oct 2026 10:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Fri, 02 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('retries a 503 up to maxRetries, with jittered backoff, then throws a retryable server error', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const { fetch, calls } = fakeFetch(() => new Response('Service Unavailable', { status: 503 }));
    const error = await caught(client(fetch, { sleep, maxRetries: 3 }).getRow(1, 1));

    expect(error.kind).toBe('server');
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(4);
    // random() = 0.5 against ceilings of 250, 500, 1000.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([125, 250, 500]);
  });

  it('does not retry a 401', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const { fetch, calls } = fakeFetch(() => jsonResponse({ error: 'ERROR_INVALID_ACCESS_TOKEN' }, 401));
    const error = await caught(client(fetch, { sleep }).getRow(1, 1));

    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('classifies a 404 on getRow as not-found, without retrying', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ error: 'ERROR_ROW_DOES_NOT_EXIST' }, 404));
    const error = await caught(client(fetch).getRow(1, 99));
    expect(error.kind).toBe('not-found');
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('ERROR_ROW_DOES_NOT_EXIST');
    expect(calls).toHaveLength(1);
  });

  it('classifies a 400 as bad-request, without retrying', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ error: 'ERROR_REQUEST_BODY_VALIDATION' }, 400));
    const error = await caught(client(fetch).createRow(1, { field_1: 'x' }));
    expect(error.kind).toBe('bad-request');
    expect(calls).toHaveLength(1);
  });

  it('retries network errors', async () => {
    const { fetch, calls } = fakeFetch((_call, index) => {
      if (index < 2) throw new TypeError('fetch failed');
      return jsonResponse(row(3));
    });
    expect((await client(fetch).getRow(1, 3)).id).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('never repeats a create after an ambiguous failure — the row may already exist', async () => {
    for (const fail of [
      () => {
        throw new TypeError('socket hang up');
      },
      () => jsonResponse({ error: 'ERROR_SERVER' }, 502),
    ]) {
      const { fetch, calls } = fakeFetch((_call, index) => (index === 0 ? fail() : jsonResponse(row(9))));
      const error = await caught(client(fetch).createRow(1, { field_1: 'x' }));
      expect(['network', 'server']).toContain(error.kind);
      expect(error.retryable).toBe(true); // the caller decides, after looking for the row
      expect(calls).toHaveLength(1);
    }
  });

  it('does not repeat a create that timed out', async () => {
    const { fetch, calls } = fakeFetch(() => new Promise<Response>(() => {}));
    const error = await caught(client(fetch, { timeoutMs: 5 }).createRow(1, { field_1: 'x' }));
    expect(error.kind).toBe('timeout');
    expect(calls).toHaveLength(1);
  });

  it('does retry a create the server refused with 429', async () => {
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0 ? jsonResponse({ error: 'ERROR_RATE_LIMIT' }, 429, { 'Retry-After': '0' }) : jsonResponse(row(9)),
    );
    expect((await client(fetch).createRow(1, { field_1: 'x' })).id).toBe(9);
    expect(calls).toHaveLength(2);
  });

  it('times out a hung request, retries it, then throws timeout', async () => {
    const { fetch, calls } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const error = await caught(client(fetch, { timeoutMs: 15, maxRetries: 2 }).getRow(1, 1));

    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.init.signal?.aborted)).toBe(true);
  });
});

describe('response validation', () => {
  it('rejects a list page of the wrong shape as invalid-response, without retrying', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ count: 'five', results: 'nope' }));
    const error = await caught(client(fetch).listRowsPage(1, 1));
    expect(error.kind).toBe('invalid-response');
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('rejects rows without a numeric id', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ count: 1, next: null, previous: null, results: [{ id: '1', field_1: 'x' }] }),
    );
    expect((await caught(client(fetch).listAllRows(1))).kind).toBe('invalid-response');
  });

  it('rejects a 200 whose body is not JSON', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>hello</html>', { status: 200 }));
    expect((await caught(client(fetch).getRow(1, 1))).kind).toBe('invalid-response');
  });

  it('validates the field listing', async () => {
    const fields = [
      { id: 101, name: 'Name', type: 'text', primary: true, order: 0 },
      { id: 102, name: 'Active', type: 'boolean', primary: false },
    ];
    const { fetch, calls } = fakeFetch(() => jsonResponse(fields));
    const result = await client(fetch).listFields(8);
    expect(result.map((f) => f.id)).toEqual([101, 102]);
    expect(calls[0].url).toBe(`${BASE}/api/database/fields/table/8/`);

    const bad = fakeFetch(() => jsonResponse([{ id: 'x', name: 1 }]));
    expect((await caught(client(bad.fetch).listFields(8))).kind).toBe('invalid-response');
  });

  it('reports a 403 on field listing as a configuration error', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: 'ERROR_NO_PERMISSION_TO_TABLE' }, 403));
    const error = await caught(client(fetch).listFields(8));
    expect(error.kind).toBe('auth');
    expect(error.status).toBe(403);
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/configuration/i);
  });
});

describe('concurrency', () => {
  it('never has more than maxConcurrency requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const { fetch, calls } = fakeFetch(async (call) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const id = Number(call.url.split('/').filter(Boolean).pop());
      return jsonResponse(row(id));
    });
    const c = client(fetch, { maxConcurrency: 3 });

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => c.getRow(1, i + 1)));

    expect(results.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(calls).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(3);
    // And the limiter is a limit, not a queue of one.
    expect(peak).toBe(3);
  });

  it('caps maxConcurrency at 8 however high it is set', async () => {
    let inFlight = 0;
    let peak = 0;
    const { fetch } = fakeFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonResponse(row(1));
    });
    const c = client(fetch, { maxConcurrency: 50 });
    await Promise.all(Array.from({ length: 20 }, () => c.getRow(1, 1)));
    expect(peak).toBe(8);
  });
});

describe('secrets in errors', () => {
  it('never puts the token in an error message, whatever the server echoes', async () => {
    const echoes: Array<() => Response> = [
      () => jsonResponse({ error: 'ERROR_INVALID_ACCESS_TOKEN', detail: `Token ${TOKEN} is invalid` }, 401),
      () => new Response(`bad token ${TOKEN}`, { status: 400 }),
      () => new Response(`upstream said Authorization: Token ${TOKEN}`, { status: 503 }),
      () => jsonResponse({ error: 'x', detail: `?token=${TOKEN}` }, 404),
    ];
    for (const echo of echoes) {
      const { fetch } = fakeFetch(echo);
      const error = await caught(client(fetch, { maxRetries: 1 }).getRow(1, 1));
      expect(error.message).not.toContain(TOKEN);
      expect(String(error.stack)).not.toContain(TOKEN);
    }
  });

  it('scrubs the exact token even when it does not look like one', async () => {
    const plain = 'lowercaseonlytoken';
    const { fetch } = fakeFetch(() => {
      throw new TypeError(`connect failed for ${plain}`);
    });
    const error = await caught(client(fetch, { token: plain, maxRetries: 0 }).getRow(1, 1));
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain(plain);
  });

  it('truncates long bodies to a bounded excerpt', async () => {
    const { fetch } = fakeFetch(() => new Response('x'.repeat(5000), { status: 400 }));
    const error = await caught(client(fetch).getRow(1, 1));
    expect(error.message.length).toBeLessThan(320);
  });
});

describe('redact', () => {
  it('strips auth schemes, credential parameters and token-shaped strings', () => {
    expect(redact(`Authorization: Token ${TOKEN}`)).not.toContain(TOKEN);
    expect(redact('Bearer abcdefghijklmnop')).toBe('Bearer [redacted]');
    expect(redact('https://x/?token=hunter2&page=1')).toBe('https://x/?token=[redacted]&page=1');
    expect(redact(`echo ${TOKEN} back`)).toBe('echo [redacted] back');
    expect(redact('eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl')).toBe('[redacted]');
  });

  it("leaves Baserow's own error codes readable", () => {
    expect(redact('ERROR_REQUEST_BODY_VALIDATION')).toBe('ERROR_REQUEST_BODY_VALIDATION');
  });

  it('bounds the length to 200 characters plus an ellipsis', () => {
    expect(redact('a'.repeat(1000))).toHaveLength(201);
  });
});
