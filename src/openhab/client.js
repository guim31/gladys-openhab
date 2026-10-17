// -----------------------------------------------------------------------------
// The openHAB REST API (openHAB 4.x and 5.x), with the fetch of Node 22.
//
//   GET  /rest/                     version (runtimeInfo), measurement system
//   GET  /rest/items?recursive=false&metadata=semantics
//   POST /rest/items/{name}         a command, as text/plain ("ON", "40", "UP")
//   POST /rest/rules/{uid}/runnow   run a rule (an administrator token)
//   GET  /rest/events?topics=...    Server-Sent Events: state changes, items
//                                   added, removed or updated, and an "alive"
//                                   event every 10 seconds.
//
// Authentication: an API token (Bearer), or a user name and password (basic,
// only when openHAB allows it: org.openhab.restauth:allowBasicAuth), or none
// when openHAB lets anonymous requests in (its default "implicit user role").
// Verified against openHAB 5.0.1 in Docker: a refused token is a 401, an
// unknown item a 404 with { error: { message } }, a refused command a 400.
// -----------------------------------------------------------------------------

export const CLIENT_TIMINGS = { requestTimeout: 10_000 };

export const EVENT_TOPICS = [
  'openhab/items/*/statechanged',
  'openhab/items/*/added',
  'openhab/items/*/removed',
  'openhab/items/*/updated',
];

/** openHAB refused the credentials (401, 403). */
export class OhAuthError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.name = 'OhAuthError';
    this.status = status;
  }
}

/** openHAB answered with an error status. */
export class OhHttpError extends Error {
  constructor(status, detail) {
    super(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
    this.name = 'OhHttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** Builds the Authorization header; never logged. */
export function authorization({ token, username, password }) {
  if (username) {
    return `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`;
  }
  return token ? `Bearer ${token}` : undefined;
}

/**
 * Splits a Server-Sent Events stream into events. Feed it text chunks; it
 * calls `onEvent({ event, data })` for every complete event.
 */
export function sseParser(onEvent) {
  let buffer = '';
  let event = 'message';
  let data = [];
  return (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer[index] === '\r' ? 2 : 1));
      if (line === '') {
        if (data.length > 0) {
          onEvent({ event, data: data.join('\n') });
        }
        event = 'message';
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      }
    }
  };
}

export class OpenhabClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl normalized by src/config.js (no /rest)
   * @param {string} [options.token]
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {typeof fetch} [options.fetch]
   * @param {object} [options.timings]
   */
  constructor({ baseUrl, token, username, password, fetch = globalThis.fetch, timings }) {
    this.baseUrl = baseUrl;
    this.auth = authorization({ token, username, password });
    this.fetch = fetch;
    this.timings = { ...CLIENT_TIMINGS, ...timings };
  }

  headers(extra = {}) {
    return { ...(this.auth ? { Authorization: this.auth } : {}), ...extra };
  }

  async request(method, path, { body, type = 'text/plain', timeout } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers({
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': type } : {}),
        }),
        body,
        signal: AbortSignal.timeout(timeout ?? this.timings.requestTimeout),
        redirect: 'error',
      });
    } catch (err) {
      // undici hides the reason (ECONNREFUSED, ENOTFOUND...) in `cause`.
      const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
      throw new Error(err?.name === 'TimeoutError' ? 'timeout' : reason, { cause: err });
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new OhAuthError(response.status);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = '';
      try {
        detail = JSON.parse(text)?.error?.message ?? '';
      } catch {
        // Not JSON: the status alone.
      }
      throw new OhHttpError(response.status, String(detail).slice(0, 200));
    }
    if (text === '') {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** @returns {Promise<{ version: string, measurementSystem?: string }>} */
  async getInfo() {
    const info = await this.request('GET', '/rest/');
    return {
      version: String(info?.runtimeInfo?.version ?? info?.version ?? ''),
      measurementSystem: info?.measurementSystem,
    };
  }

  /** Every item, without the members of the groups (they are listed anyway). */
  async getItems() {
    const items = await this.request('GET', '/rest/items?recursive=false&metadata=semantics');
    if (!Array.isArray(items)) {
      throw new Error('unexpected answer to /rest/items');
    }
    return items;
  }

  sendCommand(name, command) {
    return this.request('POST', `/rest/items/${encodeURIComponent(name)}`, {
      body: String(command),
    });
  }

  runRule(uid) {
    return this.request('POST', `/rest/rules/${encodeURIComponent(uid)}/runnow`, {
      body: '{}',
      type: 'application/json',
    });
  }

  /**
   * Opens the event stream. Resolves once openHAB accepted it, with
   * `{ close, done }`: `done` settles when the stream ends (closed by openHAB,
   * the network, or `close()`).
   * @param {(event: { event: string, data: string }) => void} onEvent
   */
  async openEvents(onEvent) {
    const controller = new AbortController();
    const topics = encodeURIComponent(EVENT_TOPICS.join(','));
    // A timeout for the answer only: the stream itself lives on.
    const timer = setTimeout(
      () => controller.abort(new DOMException('timeout', 'TimeoutError')),
      this.timings.requestTimeout,
    );
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/rest/events?topics=${topics}`, {
        headers: this.headers({ Accept: 'text/event-stream' }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
      throw new Error(err?.name === 'TimeoutError' ? 'timeout' : reason, { cause: err });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      controller.abort();
      throw new OhAuthError(response.status);
    }
    if (!response.ok || !response.body) {
      controller.abort();
      throw new OhHttpError(response.status);
    }
    const parse = sseParser(onEvent);
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const done = (async () => {
      try {
        for (;;) {
          const { value, done: finished } = await reader.read();
          if (finished) {
            return;
          }
          parse(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Aborted or cut: the caller sees the end of the stream.
      }
    })();
    return {
      close: () => {
        controller.abort();
        reader.cancel().catch(() => {});
      },
      done,
    };
  }
}
