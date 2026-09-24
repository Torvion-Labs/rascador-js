import { RascadorError } from "./errors.ts"
import { PagePromise } from "./pagination.ts"
import type {
  Category,
  GetProductParams,
  ListCategoriesParams,
  ListProductsParams,
  Me,
  Product,
  RequestOptions,
  Response,
  SearchHit,
  SearchParams,
  Source,
  SourceId,
} from "./types.ts"
import { VERSION } from "./version.ts"

export const DEFAULT_BASE_URL = "https://api.rascador.store"

/** Stored-data reads answer in well under a second. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Live scrapes drive a real browser: 20-40s typical, up to ~90s for a product refresh. */
const DEFAULT_LIVE_TIMEOUT_MS = 130_000
const DEFAULT_MAX_RETRIES = 2
const MAX_BACKOFF_MS = 8_000

export interface RascadorOptions {
  /** Defaults to the `RASCADOR_API_KEY` environment variable where one exists. */
  apiKey?: string
  /** Defaults to the production gateway. */
  baseUrl?: string
  /** Source used when a call doesn't name one. The gateway's own default is `shein`. */
  source?: SourceId
  /** Timeout for stored-data calls. Default 30s. */
  timeoutMs?: number
  /** Timeout for live calls (`search`, `products.get` with `refresh`). Default 130s. */
  liveTimeoutMs?: number
  /** Retries for errors the gateway marks retryable. Default 2. */
  maxRetries?: number
  /** Custom fetch, e.g. for a proxy or tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Extra headers sent with every request. */
  headers?: Record<string, string>
}

type Query = Record<string, string | number | boolean | undefined>

interface CallSpec {
  path: string
  query?: Query
  live?: boolean
  options?: RequestOptions
}

function readEnvKey(): string | undefined {
  // `process` doesn't exist in browsers or Deno without the node shim.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.RASCADOR_API_KEY
}

export class Rascador {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #source: SourceId | undefined
  readonly #timeoutMs: number
  readonly #liveTimeoutMs: number
  readonly #maxRetries: number
  readonly #fetch: typeof fetch
  readonly #headers: Record<string, string>

  readonly products: ProductsResource
  readonly categories: CategoriesResource
  readonly sources: SourcesResource

  constructor(options: RascadorOptions = {}) {
    const apiKey = options.apiKey ?? readEnvKey()
    if (!apiKey) {
      throw new RascadorError({
        code: "missing_credentials",
        message: "No API key. Pass `apiKey` or set the RASCADOR_API_KEY environment variable.",
        status: 0,
        retryable: false,
      })
    }

    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== "function") {
      throw new TypeError("No global fetch found. Pass `fetch` in the options (Node 18+ has one built in).")
    }

    this.#apiKey = apiKey
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.#source = options.source
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#liveTimeoutMs = options.liveTimeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    // Bound so a detached `fetch` (e.g. window.fetch) keeps its receiver.
    this.#fetch = fetchImpl.bind(globalThis)
    this.#headers = options.headers ?? {}

    this.products = new ProductsResource(this)
    this.categories = new CategoriesResource(this)
    this.sources = new SourcesResource(this)
  }

  /** The key's scopes, limits and remaining quota. Never spends quota. */
  me(options?: RequestOptions): Promise<Response<Me>> {
    return this._get({ path: "/v1/me", options })
  }

  /**
   * Live search on the source site. Slow (20–40s) and quota-heavy.
   * Returns result cards; call `products.get` for full details.
   */
  search(params: SearchParams, options?: RequestOptions): Promise<Response<SearchHit[]>> {
    const { source, ...query } = params
    return this._get({ path: "/v1/search", query: { ...query, source: this._source(source) }, live: true, options })
  }

  /** @internal */
  _source(source: SourceId | undefined): SourceId | undefined {
    return source ?? this.#source
  }

  /** @internal */
  async _get<T>(spec: CallSpec): Promise<Response<T>> {
    const url = this.#url(spec.path, spec.query)
    const maxRetries = spec.options?.maxRetries ?? this.#maxRetries
    const timeoutMs = spec.options?.timeoutMs ?? (spec.live ? this.#liveTimeoutMs : this.#timeoutMs)

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once<T>(url, timeoutMs, spec.options?.signal)
      } catch (error) {
        if (!(error instanceof RascadorError) || !error.retryable || attempt >= maxRetries) throw error
        await sleep(backoffMs(attempt, error.retryAfterSeconds), spec.options?.signal)
      }
    }
  }

  #url(path: string, query: Query | undefined): string {
    const url = new URL(this.#baseUrl + path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  async #once<T>(url: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<Response<T>> {
    const { signal: combined, cleanup, timedOut } = withTimeout(timeoutMs, signal)

    let res: globalThis.Response
    try {
      res = await this.#fetch(url, {
        method: "GET",
        headers: {
          ...this.#headers,
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        signal: combined,
      })
    } catch (cause) {
      cleanup()
      if (timedOut()) {
        // Not retried: a live scrape that outran us may still be running
        // upstream, and firing another would only stack a second one on it.
        throw new RascadorError({
          code: "timeout",
          message: `No response within ${timeoutMs}ms.`,
          status: 0,
          retryable: false,
          cause,
        })
      }
      if (signal?.aborted) throw cause
      throw new RascadorError({
        code: "network_error",
        message: cause instanceof Error ? cause.message : "The request could not be sent.",
        status: 0,
        retryable: true,
        cause,
      })
    }

    let body: unknown
    try {
      const text = await res.text()
      body = text ? JSON.parse(text) : null
    } catch (cause) {
      if (timedOut()) {
        throw new RascadorError({
          code: "timeout",
          message: `The response did not finish within ${timeoutMs}ms.`,
          status: res.status,
          retryable: false,
          cause,
        })
      }
      if (signal?.aborted) throw cause
      throw new RascadorError({
        code: "invalid_response",
        message: `Expected JSON from the gateway (HTTP ${res.status}).`,
        status: res.status,
        retryable: res.status >= 500,
        cause,
      })
    } finally {
      cleanup()
    }

    if (!res.ok) throw errorFrom(res, body)

    if (!body || typeof body !== "object" || !("data" in body)) {
      throw new RascadorError({
        code: "invalid_response",
        message: "The gateway response had no `data` field.",
        status: res.status,
        retryable: false,
      })
    }
    return body as Response<T>
  }

  /** The SDK version. Include it in bug reports. */
  static readonly VERSION: string = VERSION
}

export class ProductsResource {
  readonly #client: Rascador
  constructor(client: Rascador) {
    this.#client = client
  }

  /**
   * One product. Instant when stored; otherwise (or with `refresh: true`) a
   * live fetch, which needs the `search:live` scope.
   */
  get(id: string | number, params: GetProductParams = {}, options?: RequestOptions): Promise<Response<Product>> {
    const { source, ...query } = params
    return this.#client._get({
      path: `/v1/products/${encodeURIComponent(String(id))}`,
      query: { ...query, source: this.#client._source(source) },
      live: params.refresh === true,
      options,
    })
  }

  /** Stored products. `await` for one page, `for await` for every product. */
  list(params: ListProductsParams = {}, options?: RequestOptions): PagePromise<Product> {
    const { source, offset, ...query } = params
    return new PagePromise<Product>(
      (next) =>
        this.#client._get({
          path: "/v1/products",
          query: { ...query, offset: next, source: this.#client._source(source) },
          options,
        }),
      offset
    )
  }
}

export class CategoriesResource {
  readonly #client: Rascador
  constructor(client: Rascador) {
    this.#client = client
  }

  /** The source's category tree. `await` for one page, `for await` for all. */
  list(params: ListCategoriesParams = {}, options?: RequestOptions): PagePromise<Category> {
    const { source, offset, ...query } = params
    return new PagePromise<Category>(
      (next) =>
        this.#client._get({
          path: "/v1/categories",
          query: { ...query, offset: next, source: this.#client._source(source) },
          options,
        }),
      offset
    )
  }
}

export class SourcesResource {
  readonly #client: Rascador
  constructor(client: Rascador) {
    this.#client = client
  }

  /** Every source and what it supports. Never spends quota. */
  list(options?: RequestOptions): Promise<Response<Source[]>> {
    return this.#client._get({ path: "/v1/sources", options })
  }
}

function errorFrom(res: globalThis.Response, body: unknown): RascadorError {
  const e = (body as { error?: Record<string, unknown> } | null)?.error
  const headerRetry = Number(res.headers.get("retry-after"))

  if (!e || typeof e.code !== "string") {
    return new RascadorError({
      code: res.status >= 500 ? "internal_error" : "invalid_response",
      message: `The gateway returned HTTP ${res.status} without an error body.`,
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
      retryAfterSeconds: Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined,
    })
  }

  const retryAfter =
    typeof e.retry_after_seconds === "number"
      ? e.retry_after_seconds
      : Number.isFinite(headerRetry) && headerRetry > 0
        ? headerRetry
        : undefined

  return new RascadorError({
    code: e.code,
    message: typeof e.message === "string" ? e.message : e.code,
    status: res.status,
    retryable: e.retryable === true,
    retryAfterSeconds: retryAfter,
    requestId: typeof e.request_id === "string" ? e.request_id : undefined,
    logUrl: typeof e.log_url === "string" ? e.log_url : undefined,
    details: (e.details as Record<string, unknown> | undefined) ?? undefined,
  })
}

/** Exponential backoff with full jitter, never shorter than what the gateway asked for. */
function backoffMs(attempt: number, retryAfterSeconds: number | undefined): number {
  const jittered = Math.random() * Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt)
  return Math.max(jittered, (retryAfterSeconds ?? 0) * 1000)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** AbortSignal.any isn't in Node 18, so combine the caller's signal and the timeout by hand. */
function withTimeout(
  ms: number,
  signal: AbortSignal | undefined
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    controller.abort()
  }, ms)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener("abort", onAbort, { once: true })

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    },
    timedOut: () => fired,
  }
}
