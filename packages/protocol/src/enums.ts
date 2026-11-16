/**
 * Enumerations shared with the cloud database (packages/db migration 0001:
 * the `suite` and `severity` enums). A test keeps the two in step.
 */
export const PROTOCOL_VERSION = 1

export const SUITES = ['links', 'performance', 'security', 'seo', 'a11y', 'content', 'ai_readiness', 'monitor'] as const
export type SuiteId = (typeof SUITES)[number]

/** Most to least severe. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export type Severity = (typeof SEVERITIES)[number]

/** Sort key: lower is more severe. */
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s)

/** True when `s` is at least as severe as `threshold` (for `--fail-on`). */
export const atLeast = (s: Severity, threshold: Severity): boolean => severityRank(s) <= severityRank(threshold)

/** How a run ended. The cloud's `scan_status` adds queue states (queued, leased, running). */
export const RUN_STATUSES = ['completed', 'partial', 'failed', 'canceled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** What a suite needs from the runner. */
export const CAPABILITIES = ['http', 'browser', 'dns', 'tls', 'active-probe'] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Why a URL could not be fetched. `rate_limited` is never "broken" (COR-12). */
export const FETCH_ERRORS = [
  'timeout', 'dns_error', 'connection_error', 'tls_error', 'blocked_by_scope', 'robots_disallowed', 'too_large', 'rate_limited', 'invalid_url',
] as const
export type FetchError = (typeof FETCH_ERRORS)[number]

/** Why a whole run failed. */
export const RUN_ERRORS = ['start_url_unreachable', 'start_url_redirects_offsite', 'invalid_spec', 'internal'] as const
export type RunError = (typeof RUN_ERRORS)[number]

/** Why a run ended early with status `partial`. */
export const STOP_REASONS = ['time_budget', 'canceled'] as const
export type StopReason = (typeof STOP_REASONS)[number]
