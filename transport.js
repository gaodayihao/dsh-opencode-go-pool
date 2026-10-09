/**
 * A bounded retry budget for `TRANSPORT` failures.
 *
 * The pool route's own retry policy (`providerRetryPolicy` in `./index.js`) is
 * captured once per route and shares one attempt window across every code in
 * its retryable list — the quota window needs a generous one, because a spent
 * five-hour window really is worth waiting out. A connection that cannot be
 * established is not that: after the first few attempts the remaining wait is
 * minutes long and fixes nothing. So `TRANSPORT` is deliberately removed from
 * the route's retryable codes and answered here instead, against its own
 * per-request budget (`transportMaxRetries`).
 *
 * The budget is cleared at each new STEP (one step = one model request), which
 * is what makes the cap "per logical request". `agent/status` → `idle` is NOT
 * the reset signal: a turn's steps run inside one `running` phase, so it never
 * fires between them. `assistant/attempt` is wrong for the opposite reason —
 * the loop appends it for the FAILED attempt before dispatching
 * `agent/request-error`, so resetting there would clear the budget on every
 * failure it exists to bound.
 *
 * Deliberately free of harness imports so it runs under plain Node tests.
 *
 * @module dsh-opencode-go-pool/transport
 */

/** Failure code this budget covers (provider-neutral harness code). */
export const TRANSPORT_FAILURE_CODE = 'TRANSPORT'

/** Transport failures absorbed before the failure surfaces (default 5). */
export const DEFAULT_TRANSPORT_MAX_RETRIES = 5

/** Plausibility ceiling for the setting; mirrored in the plugin Config schema. */
export const MAX_TRANSPORT_MAX_RETRIES = 50

/**
 * One pool's live transport-failure counts.
 *
 * Keyed weakly by agent, so a dropped agent cannot leak, and instance-scoped
 * rather than module-scoped so two plugin instances (a test booting many) never
 * share a budget.
 */
export class TransportBudget {
  constructor() {
    /** @type {WeakMap<object, number>} */
    this.counts = new WeakMap()
  }

  /**
   * Count one attempt's outcome against the budget.
   * @param {object} agent - the identity the budget is scoped to.
   * @param {string} failureCode - the failed attempt's failure code.
   * @param {number} maxRetries - transport retries to absorb before surfacing.
   * @returns {'retry'|'exhausted'|'ignored'} `ignored` for any other code (the
   *   route policy decides those, unchanged).
   */
  absorb(agent, failureCode, maxRetries) {
    if (failureCode !== TRANSPORT_FAILURE_CODE) return 'ignored'
    if (!agent || typeof agent !== 'object') return 'ignored'
    const used = this.counts.get(agent) ?? 0
    if (used >= maxRetries) return 'exhausted'
    this.counts.set(agent, used + 1)
    return 'retry'
  }

  /** Clear one agent's budget (a new step starts, or the turn ended). */
  reset(agent) {
    if (!agent || typeof agent !== 'object') return
    this.counts.delete(agent)
  }

  /** The retries this agent has already spent (test/diagnostic surface). */
  used(agent) {
    return this.counts.get(agent) ?? 0
  }
}

/**
 * What one session event means for the transport budget.
 *
 * Exported and pure on purpose: the choice of event is the part of this design
 * that is easy to get plausibly wrong, so it is stated once where a test pins it.
 *
 * @param {string} type - the appended session event's type.
 * @returns {'reset'|'forget'|'none'} `reset` for a new step, `forget` when the
 *   turn ended (the session → agent mapping is no longer needed).
 */
export function transportResetAction(type) {
  if (type === 'step/start') return 'reset'
  if (type === 'turn/end') return 'forget'
  return 'none'
}

/**
 * The diagnosis a capped turn ends with. Bilingual, because the harness renders
 * a failed turn's message verbatim, and it names the budget and the checks that
 * actually help instead of the bare "fetch failed" chain the retry chrome would
 * otherwise show.
 *
 * @param {string} failureMessage - the underlying transport failure's message.
 * @param {number} maxRetries - the budget that was spent.
 * @returns {string}
 */
export function transportBudgetMessage(failureMessage, maxRetries) {
  return `${failureMessage}`
    + `；OpenCode Go 连接在连续重试 ${maxRetries} 次后仍失败——已停止重试以免整轮卡死。`
    + '这通常是本机到 opencode.ai 的网络不通，常见原因是代理未生效：DSH 只读取环境变量 '
    + 'HTTPS_PROXY/HTTP_PROXY（系统代理/PAC 不会被读取），请在启动 DSH 的终端里导出代理，'
    + '或先关闭代理直连后重试。网络恢复后直接重发即可；该次数按每次模型请求重置'
    + ` — the connection to opencode.ai still failed after ${maxRetries} automatic retries, which were`
    + ' stopped so the turn could not stall for minutes. This is a connectivity problem between this'
    + ' machine and opencode.ai, not a context-window or request-size rejection. Common cause: the proxy'
    + ' is not reaching the harness — DSH reads HTTPS_PROXY/HTTP_PROXY from the environment only (a'
    + ' Windows system proxy/PAC setting is not consulted), so export it in the launching shell, or turn'
    + ' the proxy off and retry. The budget is per model request and has been reset.'
}
