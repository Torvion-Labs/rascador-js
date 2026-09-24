/**
 * Codes the gateway can return, plus three the SDK raises itself:
 * `network_error`, `timeout` and `invalid_response`.
 *
 * The `(string & {})` keeps autocomplete for the known codes while still
 * accepting any code a newer gateway adds.
 */
export type RascadorErrorCode =
  | "invalid_request"
  | "unknown_source"
  | "missing_credentials"
  | "invalid_token"
  | "quota_exceeded"
  | "coverage_exceeded"
  | "payment_required"
  | "insufficient_scope"
  | "client_suspended"
  | "not_found"
  | "product_not_found"
  | "rate_limited"
  | "platform_busy"
  | "internal_error"
  | "gateway_misconfigured"
  | "upstream_error"
  | "upstream_unavailable"
  | "upstream_busy"
  | "upstream_timeout"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | (string & {})

export interface RascadorErrorInit {
  code: RascadorErrorCode
  message: string
  status: number
  retryable: boolean
  retryAfterSeconds?: number
  requestId?: string
  logUrl?: string
  details?: Record<string, unknown>
  cause?: unknown
}

/** Thrown for every failed call. Branch on `code`, not on `message`. */
export class RascadorError extends Error {
  override readonly name = "RascadorError"
  readonly code: RascadorErrorCode
  /** HTTP status, or 0 when no response arrived (network failure, timeout). */
  readonly status: number
  readonly retryable: boolean
  readonly retryAfterSeconds: number | undefined
  /** Quote this when contacting support. */
  readonly requestId: string | undefined
  /** This failure in your dashboard log. */
  readonly logUrl: string | undefined
  readonly details: Record<string, unknown> | undefined

  constructor(init: RascadorErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.code = init.code
    this.status = init.status
    this.retryable = init.retryable
    this.retryAfterSeconds = init.retryAfterSeconds
    this.requestId = init.requestId
    this.logUrl = init.logUrl
    this.details = init.details
  }
}

export function isRascadorError(error: unknown): error is RascadorError {
  return error instanceof RascadorError
}
