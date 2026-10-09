/**
 * Host half of dsh-opencode-go-pool.
 *
 * One class-based Cordis plugin that also exposes the `opencodePool` Typert
 * Remote (strict-mode dispatch driven by `typert.host.js`):
 *
 *   1. Keeps the `opencode-go-pool` settings section (the plugin's own Config
 *      schema; its volatile fields are the editable ones) and writes card
 *      edits through the running DSH settings service under the entry id, with
 *      the seam's revision fencing. On DSH 0.2.1 that write lands in place and
 *      never remounts the plugin.
 *   2. Maintains the KeyPool state machine, persisted to
 *      `$DSH_HOME/opencode-go-pool.state.json`.
 *   3. Owns the provider route (default `opencode-go`, taking over the
 *      single-key route dsh-llm-pi-ai serves): an LlmAdapter whose stream()
 *      silently retries with the next pool key on quota/credential failures
 *      that arrive before any content, so the conversation never notices.
 *      While the route is owned elsewhere the plugin stays dormant and
 *      re-attempts registration on every `llm/adapters-updated` commit.
 *   4. Answers the card: per-key usage from the official OpenCode Go usage
 *      endpoint, plus switch/disable/clear actions.
 *   5. Model selection: the card picks which catalog models the route
 *      exposes (listModels filters; resolveModel/stream gate the rest).
 *
 * @module dsh-opencode-go-pool
 */

import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  assertUsableApiKey,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { AUTH_CODE, KeyPool, assertKeyList } from './pool.js'
import {
  DEFAULT_TRANSPORT_MAX_RETRIES,
  MAX_TRANSPORT_MAX_RETRIES,
  TRANSPORT_FAILURE_CODE,
  TransportBudget,
  transportBudgetMessage,
  transportResetAction,
} from './transport.js'
import { fetchUsage, UsageCache } from './usage.js'
import {
  dynamicModelDescriptor,
  fetchModels,
  loadDynamicModels,
  saveDynamicModels,
} from './models.js'

export const name = 'opencode-go-pool'

const NS = 'opencode-go-pool'
const DISPLAY_NAME = 'OpenCode Zen Go（池）'
const DEFAULT_ROUTE = 'opencode-go'
const ALT_ROUTE = 'opencode-go-pool'
const DEFAULT_USAGE_BASE_URL = 'https://opencode.ai/zen/go/v1/usage'
const DEFAULT_MODELS_BASE_URL = 'https://opencode.ai/zen/go/v1/models'
const MODELS_CACHE_FILE = 'opencode-go-pool.models.json'
const DEFAULT_USAGE_REFRESH_MS = 30000
const DEFAULT_TIMEOUT_MS = 15000
const USAGE_CACHE_TTL_MS = 15000
const REVIVE_THRESHOLD_PERCENT = 98
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000
// Wait for the provider's first byte. The upstream route withholds response
// headers until the model emits its first token, so this is deliberately the
// generous end of the scale; the same 300 s the official OpenCode CLI uses.
const DEFAULT_REQUEST_TIMEOUT_MS = 300000
// A stream that ends without a terminal event: content had already reached the
// caller, so the generation was truncated rather than completed.
const STREAM_CLOSED_CODE = 'STREAM_CLOSED'
// Card-editable bound for both timeouts (one hour). Well inside the harness's
// own timer ceiling, and past anything a model request legitimately needs.
const MAX_EDITABLE_TIMEOUT_MS = 3600000
// Adapter-owned image budgets llm-pi-ai resolves into every profile; the
// hand-built catalog profile below has to carry them too (same values as
// llm-pi-ai's own resolved defaults).
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

// The default bounded transient-retry code set, plus quota for pool rotation.
// TRANSPORT is deliberately ABSENT: a connection that cannot be established is
// bounded by `transportMaxRetries` through the agent/request-error listener in
// the plugin (see ./transport.js), because this policy is captured once per
// route and a transport failure answered from here would inherit the much
// longer quota window.
//
// STREAM_CLOSED is the mirror image and IS listed: a stream that ends
// mid-generation is exactly what a retry fixes, and it must never end the turn
// on a dead connection.
const BASE_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', STREAM_CLOSED_CODE]

const keyEntry = z.object({
  id: z.string(),
  label: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
})

export const Config = z.object({
  // `route` is ordinary (non-volatile): switching it re-registers the adapter
  // and remounts the plugin, which is exactly what the restart-scoped
  // registration state below assumes.
  route: z.union([DEFAULT_ROUTE, ALT_ROUTE]).default(DEFAULT_ROUTE),
  // Everything the card edits is volatile: DSH 0.2.1's settings service is the
  // config-editor backed forms service, and only volatile fields are editable
  // without remounting the plugin. A key or model-selection change therefore
  // reaches the running pool through the loader's in-place update.
  keys: z.array(keyEntry).default([]).volatile(),
  preemptAtPercent: z.number().min(0).max(100).default(100).volatile(),
  // Consecutive non-quota failures (rate limit / server / timeout) after
  // which the pool rotates away from a key; 0 disables the rule.
  switchAfterConsecutiveFailures: z.number().min(0).max(20).default(0).volatile(),
  // Which models the pool route exposes. 'all' follows the official catalog
  // (new models appear automatically); 'custom' exposes exactly `models`.
  modelMode: z.union(['all', 'custom']).default('all').volatile(),
  models: z.array(z.string()).default([]).volatile(),
  // Advanced network tuning. All three are volatile because the card writes
  // them through the settings forms service: a path that does not lie beneath a
  // marked node is REFUSED by the loader, so an unmarked field would render as
  // a control the page could never commit.
  requestTimeoutMs: z.number().min(1000).max(MAX_EDITABLE_TIMEOUT_MS).default(DEFAULT_REQUEST_TIMEOUT_MS).volatile(),
  streamIdleTimeoutMs: z.number().min(1000).max(MAX_EDITABLE_TIMEOUT_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  transportMaxRetries: z.number().min(0).max(MAX_TRANSPORT_MAX_RETRIES).default(DEFAULT_TRANSPORT_MAX_RETRIES).volatile(),
  // The sidebar quota card is opt-in: a fresh install shows no quota surface in
  // the sidebar and runs no background poll.
  showSidebarQuota: z.boolean().default(false).volatile(),
  // The composer chip is opt-out instead: it only exists while the session runs
  // on this pool's own route, so it cannot appear (or poll) for anyone else's
  // provider — and the reference surface it mirrors shows unconditionally.
  showComposerQuota: z.boolean().default(true).volatile(),
  usageBaseUrl: z.string().default(DEFAULT_USAGE_BASE_URL),
  modelsBaseUrl: z.string().default(DEFAULT_MODELS_BASE_URL),
  usageRefreshMs: z.number().min(5000).max(300000).default(DEFAULT_USAGE_REFRESH_MS),
  timeoutMs: z.number().min(1000).max(120000).default(DEFAULT_TIMEOUT_MS),
})

/** Safe configuration used until the injected settings scope is ready. */
const FALLBACK_CONFIG = Object.freeze({
  route: DEFAULT_ROUTE,
  keys: [],
  preemptAtPercent: 100,
  switchAfterConsecutiveFailures: 0,
  modelMode: 'all',
  models: [],
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  transportMaxRetries: DEFAULT_TRANSPORT_MAX_RETRIES,
  showSidebarQuota: false,
  showComposerQuota: true,
  usageBaseUrl: DEFAULT_USAGE_BASE_URL,
  modelsBaseUrl: DEFAULT_MODELS_BASE_URL,
  usageRefreshMs: DEFAULT_USAGE_REFRESH_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
})

/** Read a plain section from a resolved config, unwrapping per-field volatile refs. */
function plainConfig(value) {
  const source = typeof value?.get === 'function' ? value.get() : value
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return {}
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [
    key,
    typeof item?.get === 'function' ? item.get() : item,
  ]))
}

/** The namespace a settings write targets: the running plugin's own entry id. */
function settingsNamespace(ctx, entry) {
  return entry?.options?.id ?? entry?.id ?? ctx.fiber?.entry?.options?.id ?? ctx.fiber?.entry?.id ?? NS
}

/**
 * Adapt the settings scope across DSH SDK generations.
 *
 * DSH 0.2.1 replaced the registered-namespace SettingsProvider with the
 * config-editor backed SettingsForms service: the plugin's own Config schema is
 * the form (its volatile fields are the editable ones) and writes go through
 * `update`/`replace` under the running entry id. `get` always re-reads the live
 * config refs, and `watch` binds the loader's in-place volatile update, so a
 * card write reaches the running pool without a remount.
 *
 * DSH 0.1.8–0.1.x expose SettingsProvider.register(), whose scope owns its own
 * persistence; it is used when present. The oldest surface exposes only the
 * config editor, which is read inside an inject(['configEditor']) callback
 * (direct property access throws without inject).
 */
export function createSettingsScope(ctx, initialConfig, entry, editor) {
  const readLive = () => ({
    ...FALLBACK_CONFIG,
    ...plainConfig(initialConfig),
    ...plainConfig(ctx.fiber?.config),
  })

  if (typeof ctx.settings?.update === 'function' && typeof ctx.settings?.replace === 'function') {
    const ns = settingsNamespace(ctx, entry)
    return {
      get: readLive,
      // The loader applies a volatile write in place and announces the changed
      // paths on this plugin's own context; that event is the live watch.
      watch: (listener) => {
        const off = ctx.on?.('loader/volatile-update', () => listener())
        return () => { if (typeof off === 'function') off() }
      },
      update: async (patch) => { await ctx.settings.update(ns, patch) },
      replace: async (section) => { await ctx.settings.replace(ns, section) },
    }
  }

  if (typeof ctx.settings?.register === 'function') {
    return ctx.settings.register(NS, Config, {
      base: initialConfig ?? {},
      validate: validateSection,
    })
  }

  const activeEditor = editor ?? ctx.configEditor
  if (typeof activeEditor?.edit !== 'function') {
    throw new Error('opencode-go-pool: no compatible settings scope is available')
  }

  const activeEntry = entry ?? ctx.fiber?.entry ?? { id: NS, name: 'dsh-opencode-go-pool' }
  return {
    get: readLive,
    // DSH 0.1.7 reloads the plugin on a profile-patch change; the scope is
    // intentionally restart-scoped and owns no live listener.
    watch: () => () => {},
    update: async (patch) => {
      await activeEditor.edit(activeEntry, current => {
        const next = { ...plainConfig(current), ...patch }
        validateSection(next)
        return next
      })
    },
    replace: async (section) => {
      validateSection(section)
      await activeEditor.edit(activeEntry, () => section)
    },
  }
}

/** Cross-field constraints the schema cannot express; refuses the write. */
function validateSection(value) {
  assertKeyList(value.keys ?? [])
}

/**
 * Build the resolved pi-ai profile for the opencode-go catalog route.
 *
 * The catalog provider is wrapped so that models fetched from the official
 * models endpoint (see refreshModels) are merged into listModels /
 * resolveModel / stream: pi-ai reads `provider.getModels()` on every call, so
 * appending freshly pulled descriptors makes new supplier models usable
 * without a pi-ai package release. Known (shipped) models are never touched.
 *
 * The returned object is a *resolved* llm-pi-ai profile, so it must carry every
 * adapter-owned field that package reads; llm-pi-ai resolves them from its own
 * Config, and this plugin owns the route directly instead.
 * @param route - provider route id (e.g. opencode-go).
 * @param dynamicDescriptors - `(route) => descriptors` for fetched models.
 * @param tuning - the two card-editable network timeouts, in milliseconds.
 * @returns the profile llm-pi-ai serves this route from.
 */
export function buildProfile(route, dynamicDescriptors, tuning = {}) {
  const upstream = opencodeGoProvider()
  if (upstream.id !== route) upstream.id = route
  const provider = {
    ...upstream,
    getModels: () => {
      const base = upstream.getModels()
      const extras = dynamicDescriptors(route).filter(descriptor => !base.some(m => m.id === descriptor.id))
      return extras.length > 0 ? [...base, ...extras] : base
    },
  }
  return {
    provider: route,
    displayName: DISPLAY_NAME,
    // `timeoutMs` is pi-ai's own request/SDK timeout (the wait for the first
    // response byte); `streamIdleTimeoutMs` is the harness adapter's watchdog
    // for a stream that stalls mid-generation. Both are genuinely applied —
    // PiAiAdapter copies `timeoutMs` into pi-ai's stream options and wraps the
    // stream in `idleWatchdog(..., streamIdleTimeoutMs)`.
    timeoutMs: tuning.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: tuning.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'opencode-go-pool.catalog.retryPolicy'),
    piProvider: provider,
    configuredMaxTokens: new Map(),
    // PiAiAdapter.modelOf() reads profile.modelErrors before it resolves any
    // model, so a profile without this map fails every
    // resolveModel/listModels-info/stream with "Cannot read properties of
    // undefined (reading 'get')" — the catalog route declares no per-model
    // failures, exactly as llm-pi-ai's own config resolution produces for a
    // catalog with none.
    modelErrors: new Map(),
  }
}

/**
 * The pi-ai auth injection the installed PiAiAdapter requires.
 *
 * 0.2.1 made `auth` a mandatory adapter option: a collection built without it
 * silently gets pi-ai's in-memory default store, which is empty at every boot
 * and discarded on every configuration change. This plugin hands every request
 * an explicit key resolved from the harness credentials seam, so no pi-ai
 * credential record is ever written or read here; the ambient context still
 * answers provider-native discovery (process environment, `~/.aws/credentials`
 * and friends) the way llm-pi-ai's own injection does.
 * @param ctx - the plugin context carrying the credentials seam.
 * @returns the `{ credentials, authContext }` pair to hand PiAiAdapter.
 */
export function createPiAiAuth(ctx) {
  return {
    credentials: {
      // Reads answer "nothing stored": this adapter family addresses keys by
      // credential reference, never by pi-ai's own record key.
      async read() { return undefined },
      async list() { return [] },
      async modify(providerId) {
        throw new LlmError(
          `opencode-go-pool: pi-ai stores no credential record for route "${providerId}";`
          + ' name an apiKeyEnv in the key list and store the secret through the credentials seam instead',
          'NO_CREDENTIAL_STORE',
        )
      },
      async delete() {},
    },
    authContext: {
      async env(name) {
        // A provider's ambient discovery asks about arbitrary names; only one
        // inside the reference grammar can have been stored, and asking the
        // seam about anything else would throw instead of answering "not set".
        if (isCredentialRefName(name)) {
          const hit = await ctx.get('credentials')?.resolve(credentialRef(name))
          if (hit !== undefined && hit.value.length > 0) return hit.value
        }
        return process.env[name]
      },
      async fileExists(path) {
        const expanded = path.startsWith('~/') || path === '~'
          ? join(homedir(), path.slice(1).replace(/^\//, ''))
          : path
        try {
          await access(expanded)
          return true
        } catch {
          // Absent, unreadable, or a broken symlink: every one of which means
          // this ambient credential source cannot be used.
          return false
        }
      },
    },
  }
}

/** A terminal error finish stating the whole pool is dry. */
function dryPoolFinish(message) {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { code: QUOTA_EXCEEDED_CODE, message } },
  }
}

/**
 * The finish for a stream that ended without a terminal event.
 *
 * The distinction matters twice over. A cut BEFORE anything was emitted is an
 * empty response the retrier can simply re-issue; a cut after content has
 * already reached the caller is a truncated generation, which must not be
 * reported as a completed turn. Both ride retryable codes on this route, so the
 * harness re-runs the step instead of ending the turn on a dead connection —
 * the failure mode a mid-generation EOF produces on any provider.
 *
 * @param {boolean} emitted - whether any content chunk reached the caller.
 */
function streamCutFinish(emitted) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: emitted
        ? {
            code: STREAM_CLOSED_CODE,
            message: 'opencode-go: the response ended mid-generation without a finish event —'
              + ' the connection was closed before the model stopped; retry to re-issue the request',
          }
        : {
            code: EMPTY_RESPONSE_CODE,
            message: 'opencode-go: the provider returned no response body — retry to re-issue the request',
          },
    },
  }
}

function isContentChunk(chunk) {
  return chunk.type === 'block-start'
    || chunk.type === 'text-delta'
    || chunk.type === 'reasoning-delta'
    || chunk.type === 'tool-call-delta'
    || chunk.type === 'block-end'
}

/** Quota → rotate; credential problems → rotate (invalid mark); everything else keeps the key. */
function isRotationFailure(failure) {
  if (!failure) return false
  const code = failure.code
  return code === QUOTA_EXCEEDED_CODE || code === INVALID_CREDENTIAL_CODE || code === AUTH_CODE
}

function failureOf(error) {
  if (error && typeof error === 'object'
      && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message }
  }
  return null
}

/**
 * The pool adapter. Metadata (catalog, retry policy shape, model resolution)
 * delegates to a catalog PiAiAdapter; stream() runs the failover loop.
 */
class OpenCodeGoPoolAdapter extends LlmAdapter {
  constructor(plugin) {
    super()
    this.plugin = plugin
  }

  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME }
  }

  providerRetryPolicy(_provider) {
    const budget = Math.max(2, this.plugin.pool.keyCount())
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: budget,
      retryableCodes: [...BASE_RETRYABLE_CODES, QUOTA_EXCEEDED_CODE],
    }, 'opencode-go-pool.retryPolicy')
  }

  async listModels(provider) {
    const list = await this.plugin.innerCatalog.listModels(provider)
    const selection = this.plugin.modelSelection()
    if (selection === null) return list
    return list.filter(entry => selection.has(entry.id))
  }

  async resolveModel(provider, model, signal) {
    const selection = this.plugin.modelSelection()
    if (selection !== null && !selection.has(model)) {
      throw new LlmError(
        `model "${model}" is not enabled in the OpenCode Go pool model selection (Settings → OpenCode Go 套餐池 → 模型选择)`,
        'UNKNOWN_MODEL',
      )
    }
    return this.plugin.innerCatalog.resolveModel(provider, model, signal)
  }

  async *stream(options) {
    const selection = this.plugin.modelSelection()
    if (selection !== null && options.model && !selection.has(options.model)) {
      throw new LlmError(
        `model "${options.model}" is not enabled in the OpenCode Go pool model selection (Settings → OpenCode Go 套餐池 → 模型选择)`,
        'UNKNOWN_MODEL',
      )
    }
    const pool = this.plugin.pool
    const attempts = pool.usableCount() + 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      const entry = pool.currentKey()
      if (!entry) {
        yield dryPoolFinish('opencode-go-pool: every key is exhausted, disabled, or invalid — add or revive a key in Settings → OpenCode Go 套餐池')
        return
      }
      const inner = this.plugin.makeAttemptAdapter(entry)
      let emitted = false
      let silentRetry = false
      let finish = null
      try {
        for await (const chunk of inner.stream(options)) {
          if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error') {
              // quota/auth codes rotate the pool; other codes count the
              // transient-failure streak and rotate once the configured
              // consecutive-failure threshold trips. Either rotation can
              // trigger a silent retry while no content was emitted.
              const rotation = pool.onFailure(entry.id, chunk.reason.failure)
              if (rotation !== null) silentRetry = !emitted
            } else if (chunk.reason.kind !== 'aborted') {
              pool.onSuccess(entry.id)
            }
            finish = chunk
            break
          }
          if (isContentChunk(chunk)) emitted = true
          yield chunk
        }
      } catch (error) {
        const failure = failureOf(error)
        if (failure) {
          const rotation = pool.onFailure(entry.id, failure)
          if (rotation !== null && !emitted) {
            silentRetry = true
          } else {
            throw error
          }
        } else {
          throw error
        }
      }
      if (silentRetry) continue
      if (finish !== null) {
        yield finish
        return
      }
      // The inner adapter ended with no terminal finish chunk: a clean EOF in
      // place of one. Reporting that as a completed turn would hand the caller a
      // half-finished step, so it is surfaced as a failure instead — and both
      // codes are retryable on this route, which is what turns a cut connection
      // into an automatic re-issue of the step rather than a dead turn.
      yield streamCutFinish(emitted)
      return
    }
  }
}

/**
 * The plugin service. Extends TypertRemoteService so the Gateway can claim
 * and dispatch the `opencodePool` invocations declared in typert.host.js.
 */
export class OpenCodeGoPool extends TypertRemoteService {
  static inject = ['llm', 'credentials', 'settings']
  static Config = Config

  constructor(ctx, config) {
    super(ctx, 'opencodePool')
    this.ctx = ctx
    this.logger = ctx.logger ?? console

    const rawConfig = plainConfig(config)
    this.scope = null
    this.settingsError = null
    this.current = () => ({ ...FALLBACK_CONFIG, ...rawConfig, ...plainConfig(this.scope?.get?.()) })

    this.pool = new KeyPool({
      stateFile: dshHomePath('opencode-go-pool.state.json'),
      reviveThresholdPercent: REVIVE_THRESHOLD_PERCENT,
    })
    this.usageCache = new UsageCache({ ttlMs: USAGE_CACHE_TTL_MS })
    // The last COMPLETED usage outcome per key, success or failure. This is what
    // `status()` reads, so painting the page is a synchronous map lookup and
    // never waits on a network round trip; `usage()` is what actually fetches.
    this.usageResults = new Map()
    // In-flight background usage refresh (dedupes the poll-driven prefetch).
    this.usageInFlight = null
    // Per-request TRANSPORT retry budget (see ./transport.js).
    this.transportBudget = new TransportBudget()
    this.transportSessions = new WeakMap()
    // The one auth injection every PiAiAdapter this plugin builds shares.
    this.piAiAuth = createPiAiAuth(ctx)
    // Models pulled from the official models endpoint (id → {id, name}).
    // Loaded from a cache file so a fetched lineup survives restarts.
    this.dynamicModels = new Map(
      loadDynamicModels(dshHomePath(MODELS_CACHE_FILE)).map(entry => [entry.id, entry]),
    )
    // Injectable fetch for refreshModels; undefined = the host fetch.
    this.fetchModelsImpl = undefined

    this.profileRoute = null
    this.profileTuning = null
    this.profileMap = null
    this.innerCatalog = null
    this.poolAdapter = null
    this.registration = null
    this.servingRoute = null
    this.lastTakeoverError = null
    this.lastModelSelection = null

    this.applyConfig()

    const bindScope = (editor) => {
      try {
        const scope = createSettingsScope(ctx, rawConfig, ctx.fiber?.entry, editor)
        this.scope = scope
        scope.watch(() => this.applyConfig())
        this.applyConfig()
      } catch (error) {
        this.settingsError = String((error && error.message) || error)
        this.logger?.warn?.(`[opencode-go-pool] settings unavailable: ${this.settingsError}`)
      }
    }
    if (typeof ctx.settings?.register === 'function' || typeof ctx.settings?.update === 'function') {
      bindScope()
    } else {
      try {
        ctx.inject(['configEditor'], configCtx => bindScope(configCtx.configEditor))
      } catch (error) {
        this.settingsError = String((error && error.message) || error)
        this.logger?.warn?.(`[opencode-go-pool] settings unavailable: ${this.settingsError}`)
      }
    }

    this.offAdaptersUpdated = ctx.on('llm/adapters-updated', () => {
      if (this.servingRoute === null) this.tryRegister()
    })
    this.installTransportBudget(ctx)
    this.tryRegister()
  }

  /**
   * Bound `TRANSPORT` failures to their own per-request budget.
   *
   * The route policy deliberately omits `TRANSPORT` (see BASE_RETRYABLE_CODES):
   * it is captured once per route and shares one attempt window across every
   * code in it, and that window has to stay generous for a genuinely spent
   * quota window. Connections get this budget instead — `transportMaxRetries`
   * automatic retries per model request, answered with the harness's own retry
   * cadence (the listener delegates to the official retrier's `next()` while
   * the budget lasts) and then surfaced with a diagnosis naming the real cause.
   *
   * The listener only acts while THIS plugin actually serves the route, so a
   * dormant deployment (the route still owned by llm-pi-ai) keeps its own
   * transport behavior untouched.
   */
  installTransportBudget(ctx) {
    const serves = provider => this.servingRoute !== null && provider === this.servingRoute
    ctx.on('agent/request-error', async ({ agent, provider, failure, signal }, next) => {
      // Checked BEFORE the budget: a cancelled turn is the user's own stop, so
      // it must neither be answered with a retry nor consume the slot a later
      // live failure needs.
      if (signal?.aborted || !serves(provider)) return next()
      const session = agent?.session
      if (session && typeof session === 'object') this.transportSessions.set(session, agent)
      const budget = this.transportMaxRetries()
      const decision = this.transportBudget.absorb(agent, failure?.code, budget)
      if (decision === 'ignored') return next()
      if (decision === 'retry') return { kind: 'retry' }
      this.logger?.warn?.(`[opencode-go-pool] transport retry budget exhausted for "${provider}" after ${budget}`)
      throw new Error(transportBudgetMessage(failure?.message ?? 'transport failure', budget))
    })
    // Reset the budget at each new STEP — one step is exactly one model request
    // — so the cap stays per logical request and the next step of the same turn
    // gets its own grace.
    ctx.on('session/event', (session, event) => {
      const action = transportResetAction(event?.type)
      if (action === 'forget') {
        this.transportSessions.delete(session)
        return
      }
      if (action !== 'reset') return
      const agent = this.transportSessions.get(session)
      if (agent !== undefined) this.transportBudget.reset(agent)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.transportBudget.reset(agent)
    })
  }

  /** The live transport-retry budget, tolerant of pre-feature config docs. */
  transportMaxRetries() {
    const value = this.current().transportMaxRetries
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return DEFAULT_TRANSPORT_MAX_RETRIES
    }
    return Math.min(Math.trunc(value), MAX_TRANSPORT_MAX_RETRIES)
  }

  // ---- configuration & registration ---------------------------------------

  applyConfig() {
    const cfg = this.current()
    this.pool.setPreempt(cfg.preemptAtPercent)
    this.pool.setConsecutiveThreshold(cfg.switchAfterConsecutiveFailures)
    this.pool.syncKeys(cfg.keys)

    // The two network timeouts are baked into the resolved profile (llm-pi-ai
    // reads them per call from the profile object it was handed), so a tuning
    // change has to rebuild the profile — and both adapters read this one map,
    // which makes the new values reach the very next request.
    const tuning = JSON.stringify([cfg.requestTimeoutMs, cfg.streamIdleTimeoutMs])
    if (this.profileRoute !== cfg.route || this.profileTuning !== tuning) {
      this.profileRoute = cfg.route
      this.profileTuning = tuning
      this.profileMap = new Map([[cfg.route, buildProfile(
        cfg.route,
        route => this.dynamicModelDescriptors(route),
        { requestTimeoutMs: cfg.requestTimeoutMs, streamIdleTimeoutMs: cfg.streamIdleTimeoutMs },
      )]])
      this.innerCatalog = new PiAiAdapter({
        profiles: () => this.profileMap,
        resolveApiKey: async () => {
          throw new Error('opencode-go-pool: the catalog adapter never resolves keys')
        },
        auth: this.piAiAuth,
        resolveAttachments: () => this.ctx.get('attachments'),
      })
    }
    if (!this.poolAdapter) this.poolAdapter = new OpenCodeGoPoolAdapter(this)

    const selection = this.modelSelectionKey(cfg)
    if (this.servingRoute === cfg.route) {
      // The model selection changed without a route change: re-announce the
      // route so model pickers refresh their catalog from the filtered
      // listModels(). Settings docs that predate the field read as 'all'.
      if (this.lastModelSelection !== null && this.lastModelSelection !== selection) {
        this.announceAdapterChange()
      }
      this.lastModelSelection = selection
      return
    }
    this.lastModelSelection = selection
    this.tryRegister()
  }

  /** A stable key for the enabled-model selection (null = all models). */
  modelSelectionKey(cfg) {
    return JSON.stringify([cfg.modelMode ?? 'all', [...(cfg.models ?? [])].sort()])
  }

  /**
   * The enabled-model filter: null = the whole catalog, otherwise the Set of
   * explicitly selected ids. Tolerates undefined fields from pre-feature
   * settings documents.
   */
  modelSelection() {
    const cfg = this.current()
    if (cfg.modelMode !== 'custom' || !Array.isArray(cfg.models) || cfg.models.length === 0) return null
    return new Set(cfg.models)
  }

  /** Re-announce the current route so adapters-updated listeners refresh catalogs. */
  announceAdapterChange() {
    if (this.registration === null || this.servingRoute === null) return
    try {
      this.registration.replace([this.servingRoute])
    } catch (error) {
      this.logger?.warn?.(`[opencode-go-pool] catalog re-announce failed: ${String((error && error.message) || error)}`)
    }
  }

  /**
   * Register (or atomically re-route) the pool adapter. A conflicting route
   * leaves the previous registration serving and records the refusal; the
   * `llm/adapters-updated` subscription retries after every topology commit,
   * so removing the opencode-go row under Settings → Models hands the route
   * to this plugin automatically.
   */
  tryRegister() {
    const route = this.current().route
    if (this.servingRoute === route) return
    try {
      if (this.registration === null) {
        this.registration = this.ctx.llm.registerAdapter([route], this.poolAdapter)
      } else {
        this.registration.replace([route])
      }
      this.servingRoute = route
      this.lastTakeoverError = null
      this.logger?.info?.(`[opencode-go-pool] serving provider route "${route}"`)
    } catch (error) {
      this.lastTakeoverError = String((error && error.message) || error)
      this.logger?.warn?.(`[opencode-go-pool] route "${route}" unavailable: ${this.lastTakeoverError}; waiting for the owning plugin to release it`)
    }
  }

  takeoverState() {
    if (this.servingRoute === DEFAULT_ROUTE) return 'serving'
    if (this.servingRoute === ALT_ROUTE) return 'own-route'
    return 'waiting'
  }

  // ---- credentials & adapters ----------------------------------------------

  /** Per-attempt adapter bound to one key: no cross-attempt key races. */
  makeAttemptAdapter(entry) {
    return new PiAiAdapter({
      profiles: () => this.profileMap,
      resolveApiKey: () => this.resolveKeyValue(entry),
      auth: this.piAiAuth,
      resolveAttachments: () => this.ctx.get('attachments'),
    })
  }

  /** Resolve one key's credential reference through the credentials seam. */
  async resolveKeyValue(entry) {
    const credentials = this.ctx.get('credentials')
    const ref = credentialRef(entry.apiKeyEnv)
    let hit
    if (credentials) {
      try {
        hit = (await credentials.resolve(ref))?.value
      } catch {
        hit = undefined
      }
    }
    if (!hit || hit.length === 0) {
      throw new LlmError(
        `opencode-go-pool: no credential for key "${entry.id}" (${entry.apiKeyEnv}) — store it through the credentials service (the web Models page writes it) or export it`,
        'MISSING_CREDENTIAL',
      )
    }
    return assertUsableApiKey(hit, 'opencode-go-pool', ref)
  }

  // ---- Typert Remote surface (the card) -------------------------------------

  /** The card-facing model selector data: catalog entries plus enabled flags. */
  async listAvailableModels(cfg) {
    const route = this.profileRoute ?? cfg.route
    let catalog = []
    try {
      if (this.innerCatalog) catalog = await this.innerCatalog.listModels(route)
    } catch {
      catalog = []
    }
    const selection = cfg.modelMode === 'custom' && Array.isArray(cfg.models) ? new Set(cfg.models) : null
    return catalog.map(entry => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      enabled: selection === null || selection.has(entry.id),
      dynamic: this.dynamicModels.has(entry.id),
    }))
  }

  /**
   * Synthesized pi-ai descriptors for the fetched models not present in the
   * shipped catalog. The wrapper provider appends these to getModels().
   */
  dynamicModelDescriptors(route) {
    return Array.from(this.dynamicModels.values(), ({ id, name }) => dynamicModelDescriptor(id, name, route))
  }

  /** The static (shipped) catalog ids, for detecting newly-fetched models. */
  staticModelIds() {
    try {
      return new Set(opencodeGoProvider().getModels().map(model => model.id))
    } catch {
      return new Set()
    }
  }

  /** Persist the fetched-model cache (best-effort). */
  persistDynamicModels() {
    saveDynamicModels(dshHomePath(MODELS_CACHE_FILE), Array.from(this.dynamicModels.values()))
  }

  /**
   * Pull the latest model lineup from the official models endpoint and merge
   * it into the catalog. Newly-added models become selectable immediately
   * (routed with a best-effort default protocol). Returns a summary the card
   * renders: total fetched, the full list, and the ids that were new.
   */
  async refreshModels() {
    const cfg = this.current()
    const baseUrl = cfg.modelsBaseUrl || DEFAULT_MODELS_BASE_URL
    // The endpoint is public, but pass the active key's credential when one is
    // resolvable (account-specific lineups); a missing key must not block.
    let apiKey
    try {
      const entry = this.pool.currentKey()
      if (entry) apiKey = await this.resolveKeyValue(entry)
    } catch {
      apiKey = undefined
    }
    const fetched = await fetchModels({
      baseUrl,
      apiKey,
      timeoutMs: cfg.timeoutMs,
      fetchImpl: this.fetchModelsImpl,
    })
    const known = this.staticModelIds()
    const before = new Set(this.dynamicModels.keys())
    const added = []
    for (const model of fetched) {
      if (!known.has(model.id) && !before.has(model.id)) added.push(model.id)
      this.dynamicModels.set(model.id, { id: model.id, name: model.name || model.id })
    }
    this.persistDynamicModels()
    // Refresh any model picker that cached the catalog from listModels().
    this.announceAdapterChange()
    return {
      count: fetched.length,
      models: fetched.map(model => ({ id: model.id, name: model.name || model.id })),
      added,
      fetchedAt: new Date().toISOString(),
    }
  }

  /**
   * The card's fast surface: pool state, config, catalog and the LAST KNOWN
   * usage per key. It performs no usage network call at all.
   *
   * That split is the whole point. The usage endpoint is per key, each query
   * carries its own timeout, and a page whose first paint waited for them sat
   * on "查询中…" for as long as the slowest key took — up to the request budget
   * per key. Now the section paints from state that is already in memory, each
   * account card renders whatever the last completed query produced, and the
   * data arrives through {@link usage}, which the caller asks for separately.
   *
   * The method is deliberately PURE: it never fetches, and it never schedules a
   * fetch. That is what lets a client decide for itself whether a surface needs
   * the numbers at all — the sidebar quota card, for instance, reads the
   * `showSidebarQuota` flag from here with no network traffic whatsoever while
   * it is switched off.
   */
  async status() {
    const cfg = this.current()
    const entries = this.pool.entries()
    const availableModels = await this.listAvailableModels(cfg)
    return {
      takeover: this.takeoverState(),
      route: this.servingRoute ?? cfg.route,
      usageRefreshMs: cfg.usageRefreshMs,
      preemptAtPercent: cfg.preemptAtPercent,
      switchAfterConsecutiveFailures: cfg.switchAfterConsecutiveFailures,
      requestTimeoutMs: cfg.requestTimeoutMs,
      streamIdleTimeoutMs: cfg.streamIdleTimeoutMs,
      transportMaxRetries: this.transportMaxRetries(),
      showSidebarQuota: cfg.showSidebarQuota === true,
      showComposerQuota: cfg.showComposerQuota === true,
      modelMode: cfg.modelMode ?? 'all',
      availableModels,
      activeId: this.pool.activeId,
      lastSwitch: this.pool.lastSwitch,
      takeoverHint: this.servingRoute ? null : this.lastTakeoverError,
      settingsAvailable: this.scope !== null,
      settingsHint: this.scope !== null ? null : (this.settingsError ?? 'the settings service exposes no writable seam'),
      usageRefreshing: this.usageInFlight !== null,
      keys: entries.map(entry => this.keyStatus(entry)),
    }
  }

  /** One key's card row, entirely from in-memory state. */
  keyStatus(entry) {
    const st = this.pool.stateOf(entry.id)
    const result = this.usageResults.get(entry.id)
    return {
      id: entry.id,
      label: entry.label,
      apiKeyEnv: entry.apiKeyEnv,
      state: st.state,
      active: entry.id === this.pool.activeId,
      usage: result?.usage ?? null,
      usageError: result?.usageError ?? null,
      fetchedAt: result?.fetchedAt ?? null,
      usagePending: result === undefined,
      credentialSet: result?.credentialSet ?? false,
      lastFailure: st.lastFailure ?? null,
    }
  }

  /**
   * The card's slow surface: query the usage endpoint for every key, in
   * parallel, one request per key (the cache dedupes and holds each result for
   * its TTL). Results land in {@link usageResults}, so the next `status()`
   * already carries them.
   *
   * Concurrent callers share one pass — the settings page, the dashboard and
   * the sidebar card poll on their own clocks.
   *
   * @returns the same per-key rows `status()` would now produce.
   */
  async usage() {
    if (this.usageInFlight !== null) return this.usageInFlight
    const run = this.runUsagePass()
    this.usageInFlight = run
    try {
      return await run
    } finally {
      if (this.usageInFlight === run) this.usageInFlight = null
    }
  }

  /** One full usage pass over the current key list. */
  async runUsagePass() {
    const cfg = this.current()
    const entries = this.pool.entries()
    await Promise.all(entries.map(async entry => {
      const at = new Date().toISOString()
      try {
        const key = await this.resolveKeyValue(entry)
        const usage = await this.usageCache.get(entry.id, () => fetchUsage({
          baseUrl: cfg.usageBaseUrl,
          apiKey: key,
          timeoutMs: cfg.timeoutMs,
        }))
        this.pool.onUsage(entry.id, usage)
        this.usageResults.set(entry.id, {
          usage, usageError: null, fetchedAt: at, credentialSet: true,
        })
      } catch (error) {
        const code = error && error.code ? error.code : 'network'
        this.usageResults.set(entry.id, {
          usage: null,
          usageError: code === 'MISSING_CREDENTIAL' ? 'no-api-key' : code,
          fetchedAt: at,
          credentialSet: code !== 'MISSING_CREDENTIAL',
        })
      }
    }))
    return {
      fetchedAt: new Date().toISOString(),
      keys: entries.map(entry => this.keyStatus(entry)),
    }
  }

  /**
   * Query the usage endpoint for every key now, and answer the current rows.
   * A public face of {@link usage} for callers that do not speak Typert.
   */
  async refreshUsage() {
    return this.usage()
  }

  async setActive(id) {
    this.pool.setActive(id)
    return true
  }

  async setDisabled(id, on) {
    this.pool.setDisabled(id, on)
    return true
  }

  async clearInvalid(id) {
    this.pool.clearInvalid(id)
    return true
  }

  /** The bound settings scope, or a descriptive failure when none is available. */
  requireScope() {
    if (this.scope !== null) return this.scope
    const reason = this.settingsError ?? 'the settings service exposes no writable seam'
    throw new Error(`opencode-go-pool: settings are unavailable — ${reason}`)
  }

  async putKeys(keys) {
    assertKeyList(keys)
    await this.requireScope().update({ keys })
    // Forget the last usage outcome of keys that are gone; newly added ones
    // read as pending until the next usage pass fills them.
    const live = new Set(keys.map(key => key.id))
    for (const id of [...this.usageResults.keys()]) {
      if (!live.has(id)) this.usageResults.delete(id)
    }
    return true
  }

  /**
   * Store one key's literal secret through the credentials seam under its
   * configured reference name. The secret never enters settings, logs, or
   * any response — the same carrier and trust domain the Models page uses
   * when it writes credentials.
   */
  async putKeySecret(id, secret) {
    const entry = this.pool.entries().find(item => item.id === id)
    if (!entry) throw new Error(`unknown key "${id}"`)
    if (typeof secret !== 'string' || secret.trim().length === 0) {
      throw new Error(`key "${id}" needs a non-empty secret`)
    }
    const credentials = this.ctx.get('credentials')
    if (!credentials || typeof credentials.set !== 'function') {
      throw new Error('no credentials service is mounted — set the key through the credentials page instead')
    }
    const ref = credentialRef(entry.apiKeyEnv)
    const usable = assertUsableApiKey(secret.trim(), 'opencode-go-pool', ref)
    await credentials.set(ref, usable)
    // A freshly supplied secret may repair an invalid-marked key.
    this.pool.clearInvalid(id)
    this.usageCache.invalidate(id)
    // Drop the last outcome too, so the card shows this key as pending rather
    // than repeating an error the new credential may have just fixed.
    this.usageResults.delete(id)
    return true
  }

  /** Update the card-visible pool settings (thresholds and tuning, never keys). */
  async putConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('putConfig needs an object')
    const patch = {}
    if (config.preemptAtPercent !== undefined) {
      const value = Number(config.preemptAtPercent)
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('preemptAtPercent must be 0..100')
      patch.preemptAtPercent = value
    }
    if (config.switchAfterConsecutiveFailures !== undefined) {
      const value = Number(config.switchAfterConsecutiveFailures)
      if (!Number.isFinite(value) || value < 0 || value > 20) throw new Error('switchAfterConsecutiveFailures must be 0..20')
      patch.switchAfterConsecutiveFailures = value
    }
    for (const field of ['requestTimeoutMs', 'streamIdleTimeoutMs']) {
      if (config[field] === undefined) continue
      const value = Number(config[field])
      if (!Number.isFinite(value) || value < 1000 || value > MAX_EDITABLE_TIMEOUT_MS) {
        throw new Error(`${field} must be a whole number of milliseconds between 1000 and ${MAX_EDITABLE_TIMEOUT_MS}`)
      }
      patch[field] = Math.round(value)
    }
    if (config.transportMaxRetries !== undefined) {
      const value = Number(config.transportMaxRetries)
      if (!Number.isInteger(value) || value < 0 || value > MAX_TRANSPORT_MAX_RETRIES) {
        throw new Error(`transportMaxRetries must be an integer 0..${MAX_TRANSPORT_MAX_RETRIES}`)
      }
      patch.transportMaxRetries = value
    }
    if (config.showSidebarQuota !== undefined) {
      if (typeof config.showSidebarQuota !== 'boolean') throw new Error('showSidebarQuota must be a boolean')
      patch.showSidebarQuota = config.showSidebarQuota
    }
    if (config.showComposerQuota !== undefined) {
      if (typeof config.showComposerQuota !== 'boolean') throw new Error('showComposerQuota must be a boolean')
      patch.showComposerQuota = config.showComposerQuota
    }
    if (config.modelMode !== undefined) {
      if (config.modelMode !== 'all' && config.modelMode !== 'custom') throw new Error('modelMode must be "all" or "custom"')
      patch.modelMode = config.modelMode
    }
    if (config.models !== undefined) {
      if (!Array.isArray(config.models) || config.models.some(id => typeof id !== 'string' || id.trim().length === 0)) {
        throw new Error('models must be an array of non-empty model ids')
      }
      patch.models = [...new Set(config.models.map(id => id.trim()))]
    }
    if (Object.keys(patch).length === 0) throw new Error('putConfig received no known fields')
    const effective = { ...this.current(), ...patch }
    if (effective.modelMode === 'custom' && (!Array.isArray(effective.models) || effective.models.length === 0)) {
      throw new Error('custom model selection needs at least one model — pick models or use modelMode "all"')
    }
    await this.requireScope().update(patch)
    return true
  }

  async takeOverState() {
    return this.takeoverState()
  }
}

export default OpenCodeGoPool
