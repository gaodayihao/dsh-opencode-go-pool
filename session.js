/**
 * The OpenCode Go session identity every request on this route must carry.
 *
 * OpenCode Go requires a stable per-conversation session id on `x-opencode-session`;
 * a request without it is answered `HTTP 400 MissingSessionID` ("Request is
 * missing x-opencode-session and cannot be routed efficiently"). pi-ai derives
 * that header from the `sessionId` field of its own stream options, and
 * `dsh-llm-pi-ai` fills that field from the harness's `GenerateOptions.sessionId`
 * — which the agent loop sets on its own requests and auxiliary callers do not.
 *
 * Measured against the live gateway on 2026-10-09 with `deepseek-v4.1-flash`:
 * no header → 400 `MissingSessionID`; the same body plus
 * `x-opencode-session: <any non-empty string>` → 200. An empty value is treated
 * as absent, so this module never returns one.
 *
 * The Auto permission preset's reviewer is the auxiliary caller that surfaced
 * this: `dsh-experimental-auto-review` dispatches `ctx.llm.stream()` with
 * provider/model/system/messages/temperature/signal and a DEEP-FROZEN options
 * object, so the id cannot be patched in at the `llm/stream` waterfall either —
 * the adapter has to hand its inner adapter a fresh request object.
 *
 * Deliberately free of harness imports so it runs under plain Node tests.
 *
 * @module dsh-opencode-go-pool/session
 */

/** The header pi-ai derives from `sessionId` (OpenCode Go's documented one). */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/**
 * The session id for one request, remembering the harness's own ids.
 *
 * The harness's id always wins when it is there: it is the conversation the
 * request belongs to, which is exactly what the gateway wants for routing and
 * prompt caching. Auxiliary calls name no session at all, so the last id seen
 * on this route is reused — an auxiliary call is dispatched on behalf of the
 * conversation that just ran (a reviewer, a title, a summary) — and a stable
 * per-process id answers before any harness request has been seen.
 *
 * The remembered id is a routing hint, never an identity check: with concurrent
 * sessions the most recent id may belong to a sibling conversation, which only
 * changes which backend serves the auxiliary request.
 */
export class SessionIdTracker {
  /**
   * @param {string} fallback - stable per-process id for the no-harness-id case.
   */
  constructor(fallback) {
    /** @type {string} */
    this.fallback = fallback
    /** @type {string|undefined} the most recent harness-supplied id. */
    this.recent = undefined
  }

  /**
   * Resolve one request's session id, remembering a harness-supplied one.
   * @param {{sessionId?: unknown}} [options] - one `GenerateOptions`-shaped request.
   * @returns {string} a non-empty session id.
   */
  idFor(options) {
    const provided = options?.sessionId
    if (typeof provided === 'string' && provided.length > 0) {
      this.recent = provided
      return provided
    }
    return this.recent ?? this.fallback
  }
}

/**
 * The request to hand the inner adapter: the same object when it already names
 * the resolved session, a shallow copy otherwise.
 *
 * A copy is mandatory rather than cosmetic. The harness freezes the agent
 * loop's own request object and `dsh-experimental-auto-review` deep-freezes
 * its auxiliary one, so assigning `sessionId` in place would throw in strict
 * mode instead of adding the header.
 *
 * @param {object} options - the caller's `GenerateOptions`.
 * @param {string} sessionId - the resolved, non-empty session id.
 * @returns {object} a request carrying that session id.
 */
export function withSessionId(options, sessionId) {
  if (options?.sessionId === sessionId) return options
  return { ...options, sessionId }
}
