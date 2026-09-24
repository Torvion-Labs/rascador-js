# @torvion/rascador

The official TypeScript SDK for the [Rascador](https://rascador.store) product data API.
It gives you structured products, categories and live search from SHEIN, AliExpress, Amazon
and Back Market.

- Zero dependencies. Uses the platform `fetch`.
- Runs on Node 18+, Bun, Deno, Cloudflare Workers / Vercel Edge and browsers.
- Typed responses, typed error codes, retries, timeouts and auto-pagination.

## Install

```sh
npm install @torvion/rascador
bun add @torvion/rascador
pnpm add @torvion/rascador
deno add jsr:@torvion/rascador
```

## Quick start

Create a key in the [dashboard](https://rascador.store/dashboard/api-keys). A `rsc_test_` key
reads stored data for free; a `rsc_live_` key adds live search.

```ts
import { Rascador } from "@torvion/rascador"

const rascador = new Rascador({ apiKey: process.env.RASCADOR_API_KEY })

const { data: me } = await rascador.me()
console.log(me.scopes, me.quota.remaining)
```

If `apiKey` is omitted, the SDK reads `RASCADOR_API_KEY` from the environment.

Every method resolves to the API's envelope unchanged, `{ data, meta }`, with field names exactly
as the [API reference](https://rascador.store/developers/reference) documents them.

## Methods

| Method | Endpoint | Notes |
| --- | --- | --- |
| `me()` | `GET /v1/me` | Scopes, limits, remaining quota. Free. |
| `sources.list()` | `GET /v1/sources` | Sources and what each supports. Free. |
| `categories.list(params)` | `GET /v1/categories` | Paginated. `q`, `level`, `parent_path`. |
| `products.list(params)` | `GET /v1/products` | Paginated. Filters below. |
| `products.get(id, params)` | `GET /v1/products/:id` | Instant when stored; live otherwise. |
| `search(params)` | `GET /v1/search` | Live. 20–40s. |

```ts
// Browse stored products
const { data: products, meta } = await rascador.products.list({
  category_id: 1727,
  on_sale: true,
  max_price: 30,
  limit: 20,
})

// Live search, then full details for a hit
const { data: hits } = await rascador.search({ q: "summer dress", pages: 1 })
const { data: product } = await rascador.products.get(hits[0]!.product_id!)
```

`products.list` filters: `category_id`, `sku`, `q`, `brand`, `min_price`, `max_price`, `color`,
`size`, `on_sale`, `only_new`, `limit`, `offset`.

## Pagination

`await` a list call to get one page. Use `for await` to walk every item; the SDK follows
`meta.pagination.has_more`.

```ts
for await (const product of rascador.products.list({ brand: "SHEIN", limit: 100 })) {
  console.log(product.title, product.price.current)
}

// Or page by page
for await (const page of rascador.categories.list({ level: 0 }).pages()) {
  console.log(page.meta.pagination)
}
```

## Sources

The gateway defaults to `shein`. Set your own default on the client and override it per call.

```ts
const rascador = new Rascador({ source: "amazon" })
await rascador.search({ q: "usb-c hub" }) // amazon
await rascador.search({ q: "refurbished iphone", source: "backmarket" })
```

## Errors

Every failure throws a `RascadorError`. Branch on `code`, not on `message`.

```ts
import { RascadorError } from "@torvion/rascador"

try {
  await rascador.search({ q: "linen shirt" })
} catch (err) {
  if (!(err instanceof RascadorError)) throw err

  switch (err.code) {
    case "quota_exceeded":
      console.log("Resets at", err.details?.resets_at)
      break
    case "insufficient_scope":
      console.log("Key is missing a scope", err.details)
      break
    default:
      console.log(err.status, err.code, err.requestId)
  }
}
```

| Field | Meaning |
| --- | --- |
| `code` | Stable machine-readable code, e.g. `rate_limited`, `product_not_found`. |
| `status` | HTTP status, or `0` when no response arrived. |
| `retryable` | The gateway says trying again may work. |
| `retryAfterSeconds` | How long the gateway asked you to wait. |
| `requestId` | Quote this to support. |
| `logUrl` | This request in your dashboard log. |
| `details` | Extra context, e.g. `resets_at`, required scopes. |

The SDK adds three codes of its own: `network_error`, `timeout` and `invalid_response`.
The full list is on [Errors & Limits](https://rascador.store/developers/errors).

## Timeouts and retries

| Option | Default | Applies to |
| --- | --- | --- |
| `timeoutMs` | 30 000 | Stored-data calls. |
| `liveTimeoutMs` | 130 000 | `search` and `products.get(id, { refresh: true })`. |
| `maxRetries` | 2 | Errors marked `retryable`, plus network failures. |

Retries use jittered exponential backoff and never wait less than `Retry-After`. Timeouts are
not retried, because the scrape may still be running upstream. The gateway refunds quota on
every 5xx, so a retried outage doesn't cost you twice.

Every method also takes per-call options:

```ts
const controller = new AbortController()
await rascador.search({ q: "desk lamp" }, { signal: controller.signal, maxRetries: 0 })
```

## Options

```ts
new Rascador({
  apiKey: "rsc_live_…",
  baseUrl: "https://api.rascador.store",
  source: "shein",
  timeoutMs: 30_000,
  liveTimeoutMs: 130_000,
  maxRetries: 2,
  fetch: customFetch, // proxies, tests, instrumentation
  headers: { "x-trace-id": "…" },
})
```

## Browsers

The SDK works in browsers, but an API key in front-end code is visible to anyone who opens
DevTools. Call Rascador from your server, or use a test key scoped to read-only data.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues: [SECURITY.md](./SECURITY.md).

## License

MIT
