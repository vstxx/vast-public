-- Per-request throttling is enforced by Cloudflare native Rate Limiting
-- bindings. The former counters contained only short-lived limiter state.
DROP TABLE IF EXISTS rate_limits;
