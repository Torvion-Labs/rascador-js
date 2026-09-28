# @torvion/rascador

## 0.2.0

### Minor Changes

- dc26f74: Live search is no longer rate limited on the gateway, so the SDK now plans for how long a live call can really take and stops retrying the failures that multiply load.

  - `liveTimeoutMs` defaults to 210s (was 130s). A live call can wait up to 15s for a free browser on a busy source, and Back Market's own deadline is 185s; the old default gave up on calls the gateway would still have answered.
  - Live calls (`search`, `products.get` with `refresh`) now retry only when the gateway turned them away before starting: `upstream_busy`, `platform_busy` and `rate_limited`. Upstream errors, timeouts and dropped connections are no longer retried on live calls, because the browser may still be running and a retry starts another. Stored-data calls retry exactly as before.
