/**
 * Wire types for the Rascador `/v1` API.
 *
 * These mirror the gateway's zod schemas (`rascador-gateway/src/schemas/*.ts`)
 * field for field, snake_case included, so what you read here is exactly what
 * the API reference documents.
 */

export type SourceId = "shein" | "aliexpress" | "amazon" | "backmarket"

export interface Pagination {
  total: number
  limit: number
  offset: number
  has_more: boolean
}

export interface Meta {
  request_id: string
  source?: SourceId
  /** Where the data came from: our cache, the stored catalogue, a live scrape, or the source registry. */
  origin?: "cache" | "store" | "live" | "registry"
  cached?: boolean
  took_ms: number
  /** This exact request in your dashboard log. */
  log_url?: string
  /** Non-fatal degradation, e.g. `category_names_unavailable`. The response is still a 200. */
  warnings?: string[]
  /** With `only_new: true`: how many products were dropped as already seen this period. */
  filtered_seen?: number
  pagination?: Pagination
}

/** What every method resolves to: the gateway's success envelope, unchanged. */
export interface Response<T> {
  data: T
  meta: Meta
}

export interface Money {
  /** On a multi-variant listing this is the cheapest variant; read it with `current_max`. */
  current: number | null
  /** Top of the price range on a multi-variant listing. */
  current_max?: number
  original: number | null
  /** ISO 4217 code as reported by the source. */
  currency: string | null
  discount_percent: number | null
  on_sale: boolean
}

export interface CategoryRef {
  id: number | null
  /** Null when the category catalogue is unavailable; see `meta.warnings`. */
  name: string | null
  url: string | null
}

export interface Product {
  /** Numeric on SHEIN/AliExpress, an ASIN string on Amazon. */
  id: number | string | null
  source: SourceId
  url: string
  detail_url: string
  sku: string | null
  title: string | null
  brand: string | null
  description: string | null
  images: string[]
  price: Money
  category: CategoryRef
  variants: { colors: string[]; sizes: string[] }
  availability: "in_stock" | "out_of_stock" | "unknown"
  availability_raw: string | null
  rating: { value: number | null; count: number | null }
  /** ISO-8601 UTC instant this data was collected. */
  scraped_at: string
}

export interface SearchHit {
  product_id: number | string | null
  url: string
  /** Null when the id could not be determined. */
  detail_url: string | null
  title: string | null
  image: string | null
  price: number | null
  original_price: number | null
  discount_percent: number | null
  currency: string | null
  rating: number | null
}

export interface Category {
  /** On SHEIN, usable as `products.list({ category_id })`. */
  id: number | null
  source_category_id: number | string | null
  name: string | null
  url: string
  /** Stable across sources, e.g. `Shoes/Boots`. */
  path: string
  parent_path: string | null
  level: number
  /** Search term that lists this category, when it has no id-addressable listing. */
  query: string | null
  first_seen_at: string | null
  last_seen_at: string | null
}

export interface Source {
  id: string
  name: string
  capabilities: {
    live_search: boolean
    live_product_fetch: boolean
    product_id_filter: boolean
    /** Filters `products.list` accepts for this source. */
    filters: string[]
    max_search_pages: number
    max_limit: number
  }
}

export interface Me {
  client_id: string
  token_id: string
  token_name: string
  environment: "live" | "test"
  plan: string
  scopes: string[]
  quota: {
    /** Billing period, YYYYMM (UTC). */
    period: string
    limit: number
    used: number
    remaining: number
    resets_at: string
    topup_balance: number
  }
  rate_limits: {
    cheap_per_minute: number
    expensive_per_minute: number
    expensive_per_day: number
    expensive_concurrent: number
  }
  /** Units charged per call type. */
  quota_costs: Record<string, number>
}

export interface SourceParam {
  /** Overrides the client's default source for this call. */
  source?: SourceId
}

export interface PageParams {
  /** 1–1000, default 50. */
  limit?: number
  offset?: number
}

export interface SearchParams extends SourceParam {
  q: string
  /** 1–5 result pages, roughly 120 products each. Default 1. */
  pages?: number
  /** Bypass the 20-day result cache. Costs more quota. */
  refresh?: boolean
}

export interface GetProductParams extends SourceParam {
  /** Force a live re-scrape (20–90s, needs `search:live`, costs more quota). */
  refresh?: boolean
}

export interface ListProductsParams extends SourceParam, PageParams {
  category_id?: number
  sku?: string
  q?: string
  brand?: string
  min_price?: number
  max_price?: number
  color?: string
  size?: string
  on_sale?: boolean
  /** Drop products this key has already been served this billing period. */
  only_new?: boolean
}

export interface ListCategoriesParams extends SourceParam, PageParams {
  q?: string
  level?: number
  parent_path?: string
}

/** Per-call overrides. */
export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxRetries?: number
}
