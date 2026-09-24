import { describe, expect, it, vi } from "vitest"
import { Rascador, RascadorError } from "../src/index.ts"

interface Call {
  url: URL
  headers: Record<string, string>
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error

/** A fetch that replays canned replies in order and records what it was asked. */
function mockFetch(...replies: Reply[]) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: init?.headers as Record<string, string> })
    const reply = replies.shift()
    if (!reply) throw new Error("unexpected request")
    if (reply instanceof Error) throw reply
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    })
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

const meta = { request_id: "req_1", took_ms: 3 }
const ok = (data: unknown, extra: object = {}) => ({ body: { data, meta: { ...meta, ...extra } } })
const fail = (status: number, code: string, retryable: boolean, extra: object = {}) => ({
  status,
  body: { error: { code, message: `${code} happened`, retryable, request_id: "req_err", ...extra } },
})

function client(replies: Reply[], options: ConstructorParameters<typeof Rascador>[0] = {}) {
  const mock = mockFetch(...replies)
  const rascador = new Rascador({ apiKey: "rsc_test_abc_secret", baseUrl: "http://gw.test/", fetch: mock.fetch, ...options })
  return { rascador, calls: mock.calls }
}

describe("construction", () => {
  it("requires an API key", () => {
    const saved = process.env.RASCADOR_API_KEY
    delete process.env.RASCADOR_API_KEY
    try {
      expect(() => new Rascador({ fetch: mockFetch().fetch })).toThrow(RascadorError)
    } finally {
      if (saved !== undefined) process.env.RASCADOR_API_KEY = saved
    }
  })

  it("falls back to RASCADOR_API_KEY", async () => {
    process.env.RASCADOR_API_KEY = "rsc_test_env_key"
    try {
      const mock = mockFetch(ok({}))
      await new Rascador({ fetch: mock.fetch, baseUrl: "http://gw.test" }).me()
      expect(mock.calls[0]!.headers.authorization).toBe("Bearer rsc_test_env_key")
    } finally {
      delete process.env.RASCADOR_API_KEY
    }
  })
})

describe("requests", () => {
  it("sends the key as a bearer token and returns the envelope untouched", async () => {
    const { rascador, calls } = client([ok({ scopes: ["products:read"] })])
    const res = await rascador.me()

    expect(calls[0]!.url.href).toBe("http://gw.test/v1/me")
    expect(calls[0]!.headers.authorization).toBe("Bearer rsc_test_abc_secret")
    expect(res).toEqual({ data: { scopes: ["products:read"] }, meta })
  })

  it("serialises params, skipping undefined and stringifying booleans", async () => {
    const { rascador, calls } = client([ok([])])
    await rascador.products.list({ category_id: 1727, on_sale: true, brand: undefined, limit: 20 })

    const q = calls[0]!.url.searchParams
    expect(calls[0]!.url.pathname).toBe("/v1/products")
    expect(q.get("category_id")).toBe("1727")
    expect(q.get("on_sale")).toBe("true")
    expect(q.get("limit")).toBe("20")
    expect(q.has("brand")).toBe(false)
    expect(q.has("offset")).toBe(false)
  })

  it("uses the client's default source and lets a call override it", async () => {
    const { rascador, calls } = client([ok([]), ok([])], { source: "amazon" })
    await rascador.search({ q: "usb hub" })
    await rascador.search({ q: "usb hub", source: "backmarket" })

    expect(calls[0]!.url.searchParams.get("source")).toBe("amazon")
    expect(calls[1]!.url.searchParams.get("source")).toBe("backmarket")
  })

  it("url-encodes product ids", async () => {
    const { rascador, calls } = client([ok({})])
    await rascador.products.get("B0/../x")
    expect(calls[0]!.url.pathname).toBe("/v1/products/B0%2F..%2Fx")
  })
})

describe("errors", () => {
  it("throws a RascadorError built from the envelope", async () => {
    const { rascador } = client([fail(402, "quota_exceeded", false, { details: { resets_at: "2026-10-01T00:00:00Z" } })])
    const err = await rascador.me().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(RascadorError)
    expect(err).toMatchObject({
      code: "quota_exceeded",
      status: 402,
      retryable: false,
      requestId: "req_err",
      details: { resets_at: "2026-10-01T00:00:00Z" },
    })
  })

  it("does not retry a non-retryable error", async () => {
    const { rascador, calls } = client([fail(403, "insufficient_scope", false)])
    await expect(rascador.search({ q: "x" })).rejects.toMatchObject({ code: "insufficient_scope" })
    expect(calls).toHaveLength(1)
  })

  it("reports a non-JSON body as invalid_response", async () => {
    const mock = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }))
    const rascador = new Rascador({ apiKey: "k", baseUrl: "http://gw.test", fetch: mock as unknown as typeof fetch, maxRetries: 0 })
    await expect(rascador.me()).rejects.toMatchObject({ code: "invalid_response", status: 502, retryable: true })
  })
})

describe("retries", () => {
  it("retries retryable errors, then succeeds", async () => {
    vi.useFakeTimers()
    try {
      const { rascador, calls } = client([fail(503, "upstream_busy", true), ok(["hit"])])
      const pending = rascador.search({ q: "x" })
      await vi.runAllTimersAsync()

      await expect(pending).resolves.toMatchObject({ data: ["hit"] })
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits at least retry_after_seconds", async () => {
    vi.useFakeTimers()
    try {
      const { rascador, calls } = client([fail(429, "rate_limited", true, { retry_after_seconds: 5 }), ok({})])
      const pending = rascador.me()

      await vi.advanceTimersByTimeAsync(4_900)
      expect(calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(200)
      await pending
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up after maxRetries", async () => {
    const { rascador, calls } = client(
      [fail(502, "upstream_error", true), fail(502, "upstream_error", true)],
      { maxRetries: 1 }
    )
    vi.spyOn(Math, "random").mockReturnValue(0)
    await expect(rascador.me()).rejects.toMatchObject({ code: "upstream_error" })
    expect(calls).toHaveLength(2)
    vi.restoreAllMocks()
  })

  it("retries network failures", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const { rascador, calls } = client([new TypeError("fetch failed"), ok({})])
    await expect(rascador.me()).resolves.toBeDefined()
    expect(calls).toHaveLength(2)
    vi.restoreAllMocks()
  })
})

describe("timeouts and cancellation", () => {
  const hangingFetch = (async (_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })) as unknown as typeof fetch

  it("times out without retrying", async () => {
    const rascador = new Rascador({ apiKey: "k", baseUrl: "http://gw.test", fetch: hangingFetch, timeoutMs: 20 })
    await expect(rascador.me()).rejects.toMatchObject({ code: "timeout", retryable: false })
  })

  it("gives live calls the longer timeout", async () => {
    const seen: number[] = []
    const rascador = new Rascador({
      apiKey: "k",
      baseUrl: "http://gw.test",
      timeoutMs: 20,
      liveTimeoutMs: 60,
      fetch: (async (input: unknown, init?: RequestInit) => {
        const started = Date.now()
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            seen.push(Date.now() - started)
            reject(new DOMException("aborted", "AbortError"))
          })
        })
      }) as unknown as typeof fetch,
    })

    await expect(rascador.search({ q: "x" })).rejects.toMatchObject({ code: "timeout" })
    expect(seen[0]).toBeGreaterThanOrEqual(50)
  })

  it("passes the caller's abort through as-is", async () => {
    const rascador = new Rascador({ apiKey: "k", baseUrl: "http://gw.test", fetch: hangingFetch })
    const controller = new AbortController()
    const pending = rascador.me({ signal: controller.signal })
    controller.abort(new Error("user cancelled"))
    await expect(pending).rejects.not.toBeInstanceOf(RascadorError)
  })
})

describe("pagination", () => {
  const page = (items: number[], offset: number, limit: number, total: number) =>
    ok(items, { pagination: { total, limit, offset, has_more: offset + limit < total } })

  it("await returns only the first page", async () => {
    const { rascador, calls } = client([page([1, 2], 0, 2, 5)])
    const res = await rascador.products.list({ limit: 2 })
    expect(res.data).toEqual([1, 2])
    expect(calls).toHaveLength(1)
  })

  it("for await walks every page by offset + limit", async () => {
    const { rascador, calls } = client([page([1, 2], 0, 2, 5), page([3], 2, 2, 5), page([5], 4, 2, 5)])
    const seen: unknown[] = []
    for await (const item of rascador.products.list({ limit: 2, only_new: true })) seen.push(item)

    expect(seen).toEqual([1, 2, 3, 5])
    // A short page (only_new dropped one) still advances by the full limit.
    expect(calls.map((c) => c.url.searchParams.get("offset"))).toEqual([null, "2", "4"])
  })

  it("starts from the caller's offset", async () => {
    const { rascador, calls } = client([page([7], 10, 50, 11)])
    for await (const _ of rascador.categories.list({ offset: 10 })) void _
    expect(calls[0]!.url.searchParams.get("offset")).toBe("10")
  })
})
