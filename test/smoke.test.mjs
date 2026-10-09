import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFormsSettings } from './fixtures/forms-settings.mjs'

// Cordis-context smoke tests. They exercise the real plugin against mocked
// seams, but need the DeepSeek Harness peer dependencies installed. In a
// checkout that does not have them (e.g. `node --test` on a fresh clone),
// every test skips instead of failing: the pool/usage unit tests already
// cover the dependency-free logic.

/** Point DSH_HOME at a fresh temp dir so tests never touch the real state file. */
function isolateHome(t) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-opencode-go-pool-'))
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
}

async function loadHarness(t) {
  isolateHome(t)
  let Context, OpenCodeGoPool
  try {
    ;({ Context } = await import('@deepseek-ai/cordis'))
    ;({ OpenCodeGoPool } = await import('../index.js'))
  } catch {
    t.skip('harness peer deps not installed — link the DSH node_modules to run smoke tests')
    return null
  }
  return { Context, OpenCodeGoPool }
}

function makeMockLlms() {
  return {
    registered: [],
    adapter: null,
    registerAdapter(routes, adapter) {
      this.registered.push([...routes])
      this.adapter = adapter
      return {
        replace: next => { this.registered.push([...next]) },
      }
    },
  }
}

/**
 * Boot the plugin against the DSH 0.2.1 settings surface: the forms-settings
 * double stands in for `@deepseek-ai/dsh-settings`, and the plugin's own
 * validated Config carries the volatile refs the double writes in place.
 */
async function bootPlugin(Context, OpenCodeGoPool, rawConfig, options = {}) {
  const root = options.root ?? new Context()
  const llms = options.llms ?? makeMockLlms()
  const settings = createFormsSettings(root)
  root.provide('llm', llms)
  root.provide('settings', settings.service)
  root.provide('credentials', options.credentials ?? { resolve: async () => undefined })
  const fiber = await root.plugin(OpenCodeGoPool, rawConfig)
  settings.bind(fiber.config)
  return { root, llms, settings: settings.state, plugin: root.get('opencodePool') }
}

test('plugin registers the opencode-go route and serves the pi-ai catalog', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const { root, llms } = await bootPlugin(Context, OpenCodeGoPool, {})
  assert.ok(llms.adapter, 'pool adapter registered')
  assert.deepEqual(llms.registered[0], ['opencode-go'])

  const models = await llms.adapter.listModels('opencode-go')
  assert.ok(Array.isArray(models) && models.length > 0, 'catalog lists models')
  const ids = models.map(m => m.id)
  assert.ok(ids.includes('deepseek-v4-flash'), 'catalog keeps opencode-go models')

  // Dry pool: no keys configured → the stream yields one terminal quota error
  // instead of making any provider request.
  const chunks = []
  for await (const chunk of llms.adapter.stream({
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'QUOTA')
  await root.fiber.dispose()
})

test('a key without a resolvable credential fails the stream loud (MISSING_CREDENTIAL)', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const { root, llms } = await bootPlugin(Context, OpenCodeGoPool, {
    keys: [{ id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' }],
  })
  const stream = llms.adapter.stream({
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  await assert.rejects(async () => {
    for await (const _chunk of stream) { /* drain */ }
  }, err => err.code === 'MISSING_CREDENTIAL')
  await root.fiber.dispose()
})

test('status() reports the pool without network when keys are empty', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const { root, plugin } = await bootPlugin(Context, OpenCodeGoPool, {})
  const status = await plugin.status()
  assert.equal(status.takeover, 'serving')
  assert.equal(status.route, 'opencode-go')
  assert.deepEqual(status.keys, [])
  await root.fiber.dispose()
})

test('putKeys applies live through the 0.2.1 forms seam without remounting', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  /** Count constructions to prove a volatile write does not remount the plugin. */
  let constructions = 0
  class CountingPool extends OpenCodeGoPool {
    constructor(...args) {
      super(...args)
      constructions += 1
    }
  }

  const { root, settings, plugin } = await bootPlugin(Context, CountingPool, {})
  assert.equal(constructions, 1)
  assert.equal(plugin.pool.keyCount(), 0)

  await plugin.putKeys(TWO_KEYS)
  assert.equal(settings.writes.length, 1, 'putKeys writes through the settings service')
  assert.equal(settings.writes[0].ns, 'opencode-go-pool', 'the write targets the plugin entry id')
  assert.deepEqual(settings.writes[0].patch.keys.map(key => key.id), ['acc-a', 'acc-b'])
  assert.equal(plugin.pool.keyCount(), 2, 'the in-place volatile write reaches the running pool')
  assert.equal(constructions, 1, 'the volatile write did not remount the plugin')

  // The model selection takes the same live path.
  await plugin.putConfig({ modelMode: 'custom', models: ['deepseek-v4-flash'] })
  assert.deepEqual([...plugin.modelSelection()], ['deepseek-v4-flash'])
  assert.equal(settings.writes[1].ns, 'opencode-go-pool')

  // Validation still refuses a bad write before it reaches the seam.
  await assert.rejects(
    () => plugin.putKeys([
      { id: 'acc-a', label: 'A', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
      { id: 'acc-b', label: 'B', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
    ]),
    /duplicate apiKeyEnv/,
  )
  assert.equal(settings.writes.length, 2, 'a refused write never reaches the settings seam')
  await root.fiber.dispose()
})

test('still binds the 0.1.x SettingsProvider.register seam when it is the only one', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const root = new Context()
  const llms = makeMockLlms()
  const writes = []
  let section = { keys: [] }
  root.provide('llm', llms)
  root.provide('settings', {
    register: (ns, schema, options) => {
      assert.equal(ns, 'opencode-go-pool')
      assert.ok(schema, 'the plugin Config schema is registered')
      assert.equal(typeof options.validate, 'function')
      assert.ok(options.base, 'the resolved entry config is the base layer')
      return {
        get: () => section,
        watch: () => () => {},
        update: async (patch) => { writes.push(patch); section = { ...section, ...patch } },
        replace: async (next) => { section = next },
      }
    },
  })
  root.provide('credentials', { resolve: async () => undefined })

  await root.plugin(OpenCodeGoPool, {})
  const plugin = root.get('opencodePool')
  assert.ok(plugin.scope, 'the registered scope is bound')
  await plugin.putKeys([{ id: 'acc-a', label: 'A', apiKeyEnv: 'OPENCODE_GO_KEY_A' }])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].keys[0].id, 'acc-a')
  assert.equal(plugin.current().keys.length, 1, 'the registered scope is authoritative for reads')
  await root.fiber.dispose()
})

test('mounts with the DSH 0.1.7 configEditor seam and no settings.register', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const root = new Context()
  const llms = makeMockLlms()
  const edits = []
  root.provide('llm', llms)
  // DSH 0.1.7 exposes the settings service without SettingsProvider.register().
  root.provide('settings', {})
  root.provide('configEditor', {
    edit: async (_entry, change) => { edits.push(change({ keys: [] }, {})) },
  })
  root.provide('credentials', { resolve: async () => undefined })

  await root.plugin(OpenCodeGoPool, {})
  const plugin = root.get('opencodePool')
  assert.ok(plugin, 'plugin mounts and exposes opencodePool')
  for (let i = 0; i < 10 && plugin.scope === null; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  assert.notEqual(plugin.scope, null, 'the configEditor inject callback binds a settings scope')
  assert.equal(plugin.scope.get().route, 'opencode-go', 'scope reads the plugin fiber config')
  assert.ok(Array.isArray(plugin.scope.get().keys), 'scope normalizes the config section')
  const dispose = plugin.scope.watch(() => { throw new Error('unexpected live watch on DSH 0.1.7') })
  assert.equal(typeof dispose, 'function', 'restart-scoped watch returns a disposer')
  dispose()
  await plugin.putKeys([{ id: 'acc-a', label: 'A', apiKeyEnv: 'OPENCODE_GO_KEY_A' }])
  assert.equal(edits.length, 1, 'putKeys writes through the configEditor seam')
  assert.equal(edits[0].keys[0].id, 'acc-a')
  assert.deepEqual(llms.registered[0], ['opencode-go'])

  const status = await plugin.status()
  assert.equal(status.takeover, 'serving')
  assert.equal(status.route, 'opencode-go')
  assert.equal(status.settingsAvailable, true)
  assert.equal(status.settingsHint, null)
  await root.fiber.dispose()
})

test('reports unavailable settings and refuses writes without any settings seam', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const root = new Context()
  const llms = makeMockLlms()
  root.provide('llm', llms)
  root.provide('settings', {})
  root.provide('credentials', { resolve: async () => undefined })

  await root.plugin(OpenCodeGoPool, {})
  const plugin = root.get('opencodePool')
  assert.ok(plugin, 'plugin still mounts without a settings seam')
  assert.equal(plugin.scope, null, 'no scope is bound when settings exposes no seam')

  const status = await plugin.status()
  assert.equal(status.settingsAvailable, false)
  assert.match(status.settingsHint, /settings/i)
  await assert.rejects(
    () => plugin.putKeys([{ id: 'acc-a', label: 'A', apiKeyEnv: 'OPENCODE_GO_KEY_A' }]),
    /settings are unavailable/i,
  )
  await assert.rejects(
    () => plugin.putConfig({ preemptAtPercent: 80 }),
    /settings are unavailable/i,
  )
  await root.fiber.dispose()
})

test('takeover: dormant while the route is owned elsewhere, auto-registers on adapters-updated', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const root = new Context()
  const llms = makeMockLlms()
  let blocked = true
  const recorded = []
  llms.registerAdapter = (routes, adapter) => {
    if (blocked) throw new Error('llm: duplicate adapter for provider "opencode-go"')
    recorded.push([...routes])
    return { replace: next => { recorded.push([...next]) } }
  }
  const { plugin } = await bootPlugin(Context, OpenCodeGoPool, {}, { root, llms })

  // While pi-ai (or any plugin) owns the route: dormant, surfaced as waiting.
  assert.equal(plugin.takeoverState(), 'waiting')
  const waiting = await plugin.status()
  assert.equal(waiting.takeover, 'waiting')
  assert.ok(waiting.takeoverHint, 'the refusal reason rides the card hint')

  // The owner releases the route → the registry emits adapters-updated →
  // the plugin takes over automatically.
  blocked = false
  root.emit('llm/adapters-updated')
  assert.equal(plugin.takeoverState(), 'serving')
  assert.deepEqual(recorded, [['opencode-go']])
  const serving = await plugin.status()
  assert.equal(serving.takeover, 'serving')
  assert.equal(serving.takeoverHint, null)
  await root.fiber.dispose()
})

/** Scripted fake inner adapter: each stream() call consumes one script step. */
class FakeInnerAdapter {
  constructor(script) {
    this.script = script
    this.calls = 0
  }
  async *stream(_options) {
    const step = this.script[Math.min(this.calls++, this.script.length - 1)]
    for (const chunk of step) yield chunk
  }
}

const quotaFinish = {
  type: 'finish',
  reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota exhausted' } },
}
const successChunks = [
  { type: 'text-delta', index: 0, text: 'hello' },
  { type: 'finish', reason: { kind: 'stop' } },
]
const TWO_KEYS = [
  { id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
  { id: 'acc-b', label: '备用2', apiKeyEnv: 'OPENCODE_GO_KEY_B' },
]
const REQUEST = {
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

async function bootPoolPlugin(Context, OpenCodeGoPool, keys) {
  const { root, llms, plugin } = await bootPlugin(Context, OpenCodeGoPool, { keys })
  return { root, llms, plugin }
}

test('failover: a pre-content quota failure silently retries with the next key', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness
  const { root, llms, plugin } = await bootPoolPlugin(Context, OpenCodeGoPool, TWO_KEYS)

  // Attempt 1 fails with quota before any content; attempt 2 succeeds.
  const fake = new FakeInnerAdapter([[quotaFinish], successChunks])
  plugin.makeAttemptAdapter = () => fake

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)

  // The consumer sees exactly one successful stream — no error ever surfaced.
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[0], { type: 'text-delta', index: 0, text: 'hello' })
  assert.equal(chunks[1].type, 'finish')
  assert.equal(chunks[1].reason.kind, 'stop')
  assert.equal(fake.calls, 2)
  assert.equal(plugin.pool.stateOf('acc-a').state, 'exhausted')
  assert.equal(plugin.pool.activeId, 'acc-b')
  assert.equal(plugin.pool.lastSwitch.reason, 'quota')
  await root.fiber.dispose()
})

test('failover: a mid-stream quota failure surfaces the error but still rotates', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness
  const { root, llms, plugin } = await bootPoolPlugin(Context, OpenCodeGoPool, TWO_KEYS)

  // Content was already emitted → cannot silently retry; rotate and surface.
  const fake = new FakeInnerAdapter([[
    { type: 'text-delta', index: 0, text: 'partial' },
    quotaFinish,
  ]])
  plugin.makeAttemptAdapter = () => fake

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].type, 'text-delta')
  assert.equal(chunks[1].type, 'finish')
  assert.equal(chunks[1].reason.kind, 'error')
  assert.equal(chunks[1].reason.failure.code, 'QUOTA')
  assert.equal(fake.calls, 1, 'no silent retry after content was emitted')
  assert.equal(plugin.pool.stateOf('acc-a').state, 'exhausted')
  assert.equal(plugin.pool.activeId, 'acc-b')
  await root.fiber.dispose()
})

test('failover: exhausting every key surfaces one terminal dry-pool error', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness
  const { root, llms, plugin } = await bootPoolPlugin(Context, OpenCodeGoPool, TWO_KEYS)

  // Every attempt fails with quota before content: both keys silently rotate,
  // then the pool is dry and yields the terminal error exactly once.
  const fake = new FakeInnerAdapter([[quotaFinish]])
  plugin.makeAttemptAdapter = () => fake

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'QUOTA')
  assert.equal(fake.calls, 2, 'one attempt per key')
  assert.equal(plugin.pool.usableCount(), 0)
  await root.fiber.dispose()
})

test('failover: non-rotation failures keep the key and surface immediately', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness
  const { root, llms, plugin } = await bootPoolPlugin(Context, OpenCodeGoPool, TWO_KEYS)

  const fake = new FakeInnerAdapter([[
    { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } },
  ]])
  plugin.makeAttemptAdapter = () => fake

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.failure.code, 'RATE_LIMIT')
  assert.equal(fake.calls, 1, 'no rotation retry for rate limits')
  assert.equal(plugin.pool.stateOf('acc-a').state, 'healthy')
  assert.equal(plugin.pool.activeId, 'acc-a')
  await root.fiber.dispose()
})

test('a stream that ends without a finish event is surfaced as a retryable cut', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  // Content reached the caller and then the generator simply ended: that is a
  // truncated generation, never a completed turn.
  const { root, llms, plugin } = await bootPoolPlugin(Context, OpenCodeGoPool, TWO_KEYS)
  plugin.makeAttemptAdapter = () => new FakeInnerAdapter([[
    { type: 'text-delta', index: 0, text: 'partial answer' },
  ]])
  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[1].type, 'finish')
  assert.equal(chunks[1].reason.kind, 'error')
  assert.equal(chunks[1].reason.failure.code, 'STREAM_CLOSED')
  // Both cut codes ride the route policy's whitelist, which is what makes the
  // harness re-issue the step instead of ending the turn.
  assert.ok(llms.adapter.providerRetryPolicy('opencode-go').retryableCodes.includes('STREAM_CLOSED'))
  assert.ok(llms.adapter.providerRetryPolicy('opencode-go').retryableCodes.includes('EMPTY_RESPONSE'))
  await root.fiber.dispose()

  // Nothing at all came out: an empty response, which the retrier re-issues.
  const empty = await bootPoolPlugin(Context, OpenCodeGoPool, TWO_KEYS)
  empty.plugin.makeAttemptAdapter = () => new FakeInnerAdapter([[]])
  const emptyChunks = []
  for await (const chunk of empty.llms.adapter.stream(REQUEST)) emptyChunks.push(chunk)
  assert.equal(emptyChunks.length, 1)
  assert.equal(emptyChunks[0].reason.failure.code, 'EMPTY_RESPONSE')
  await empty.root.fiber.dispose()
})

test('a normal finish is passed through untouched', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const { root, llms, plugin } = await bootPoolPlugin(Context, OpenCodeGoPool, TWO_KEYS)
  plugin.makeAttemptAdapter = () => new FakeInnerAdapter([successChunks])
  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  await root.fiber.dispose()
})

// ---------------------------------------------------------------------------
// status() / usage(): the page's first paint must never wait on the network.
//
// The usage endpoint is per key and each query carries its own timeout, so the
// old single-RPC shape left the settings section on "查询中…" until the slowest
// key answered. These tests pin the split: `status()` is a synchronous read of
// state already in memory, `usage()` is the only thing that fetches.

/** Replace globalThis.fetch for one test and always restore it. */
function stubFetch(t, impl) {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return impl(url, init)
  }
  t.after(() => { globalThis.fetch = previous })
  return calls
}

const OK_USAGE = {
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
    weekly: { status: 'ok', percent: 34, resetsAt: null },
    monthly: { status: 'ok', percent: 56, resetsAt: null },
  },
}

const KEYED_CREDENTIALS = { resolve: async ref => ({ value: `sk-${String(ref)}` }) }

test('status() paints without ever touching the usage endpoint', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const calls = stubFetch(t, async () => ({ ok: true, status: 200, json: async () => OK_USAGE }))
  const { root, plugin } = await bootPlugin(Context, OpenCodeGoPool,
    { keys: TWO_KEYS }, { credentials: KEYED_CREDENTIALS })

  // status() is PURE: it issues no request and schedules none. That is what
  // lets the sidebar card read the showSidebarQuota flag without any traffic
  // while it is switched off, and what makes the settings page's first paint
  // instant regardless of how slow the usage endpoint is.
  const status = await plugin.status()
  assert.equal(status.keys.length, 2)
  for (const key of status.keys) {
    assert.equal(key.usage, null, 'nothing is invented before the first query lands')
    assert.equal(key.usagePending, true, 'a key with no completed query reads as pending')
    assert.equal(key.usageError, null)
  }
  assert.equal(status.usageRefreshing, false)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls.length, 0, 'status() never fetches')

  // usage() is the only thing that does, and it fills the same rows.
  const usage = await plugin.usage()
  assert.equal(calls.length, 2)
  assert.equal(usage.keys[0].usage.rolling.percent, 12)
  const after = await plugin.status()
  assert.equal(after.keys[0].usage.rolling.percent, 12, 'the pass landed in memory')
  assert.equal(after.keys[0].usagePending, false)
  await root.fiber.dispose()
})

test('concurrent usage() callers share one pass', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const calls = stubFetch(t, async () => ({ ok: true, status: 200, json: async () => OK_USAGE }))
  const { root, plugin } = await bootPlugin(Context, OpenCodeGoPool,
    { keys: TWO_KEYS }, { credentials: KEYED_CREDENTIALS })

  const [first, second] = await Promise.all([plugin.usage(), plugin.usage()])
  assert.equal(calls.length, 2, 'two keys, one request each — not two passes')
  assert.deepEqual(first.keys.map(key => key.id), second.keys.map(key => key.id))
  await root.fiber.dispose()
})

test('usage() fills the rows and status() then reports them', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const calls = stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => OK_USAGE,
  }))

  const { root, plugin } = await bootPlugin(Context, OpenCodeGoPool,
    { keys: TWO_KEYS }, { credentials: KEYED_CREDENTIALS })

  const usage = await plugin.usage()
  assert.equal(usage.keys.length, 2)
  for (const key of usage.keys) {
    assert.equal(key.usagePending, false)
    assert.equal(key.usage.rolling.percent, 12)
    assert.equal(key.usage.weekly.percent, 34)
    assert.equal(key.usage.monthly.percent, 56)
    assert.equal(key.credentialSet, true)
    assert.ok(key.fetchedAt, 'the row carries when it was fetched')
  }
  assert.equal(calls.length, 2, 'one request per key')

  // The values are held, so the next status() carries them without another call.
  const status = await plugin.status()
  assert.equal(status.keys[0].usage.rolling.percent, 12)
  assert.equal(status.keys[0].usagePending, false)
  // Recently fetched → the TTL still holds → nothing new is scheduled.
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls.length, 2, 'a fresh value is not re-fetched')
  await root.fiber.dispose()
})

test('usage() records a per-key failure without losing the other key', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  let seen = 0
  stubFetch(t, async () => {
    seen += 1
    if (seen === 1) return { ok: false, status: 401, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => OK_USAGE }
  })

  const { root, plugin } = await bootPlugin(Context, OpenCodeGoPool,
    { keys: TWO_KEYS }, { credentials: KEYED_CREDENTIALS })

  const usage = await plugin.usage()
  const rejection = usage.keys.find(key => key.usageError === 'unauthorized')
  const good = usage.keys.find(key => key.usage !== null)
  assert.ok(rejection, 'the rejected key reports the coded failure')
  assert.equal(rejection.usage, null)
  assert.equal(rejection.credentialSet, true, 'a 401 still proves a credential was present')
  assert.ok(good, 'the other key keeps its numbers')
  assert.equal(good.usage.rolling.percent, 12)
  await root.fiber.dispose()
})

test('a key with no resolvable credential reports no-api-key, not a network error', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const calls = stubFetch(t, async () => ({ ok: true, status: 200, json: async () => OK_USAGE }))
  const { root, plugin } = await bootPlugin(Context, OpenCodeGoPool,
    { keys: TWO_KEYS }, { credentials: { resolve: async () => undefined } })

  const usage = await plugin.usage()
  for (const key of usage.keys) {
    assert.equal(key.usageError, 'no-api-key')
    assert.equal(key.credentialSet, false)
  }
  assert.equal(calls.length, 0, 'a missing credential never reaches the endpoint')
  await root.fiber.dispose()
})

// ---------------------------------------------------------------------------
// The advanced network settings.

test('the route retry policy leaves TRANSPORT to the transport budget', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const { root, llms } = await bootPlugin(Context, OpenCodeGoPool, { keys: TWO_KEYS })
  const policy = llms.adapter.providerRetryPolicy('opencode-go')
  assert.equal(policy.mode, 'normal')
  assert.ok(!policy.retryableCodes.includes('TRANSPORT'),
    'TRANSPORT must not ride the shared (quota-length) route window')
  for (const code of ['QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'EMPTY_RESPONSE']) {
    assert.ok(policy.retryableCodes.includes(code), `${code} stays retryable on the route`)
  }
  await root.fiber.dispose()
})

test('the transport budget answers TRANSPORT, then surfaces a diagnosis', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const { root } = await bootPlugin(Context, OpenCodeGoPool,
    { keys: TWO_KEYS, transportMaxRetries: 2 }, { credentials: KEYED_CREDENTIALS })

  const agent = { session: {} }
  const payload = {
    agent,
    turn: 1,
    step: 1,
    provider: 'opencode-go',
    failure: { code: 'TRANSPORT', message: 'fetch failed' },
    signal: new AbortController().signal,
  }
  const dispatch = () => root.waterfall('agent/request-error', payload, () => Promise.resolve(undefined))

  assert.deepEqual(await dispatch(), { kind: 'retry' }, 'first transport failure retries')
  assert.deepEqual(await dispatch(), { kind: 'retry' }, 'second transport failure retries')
  await assert.rejects(dispatch, /HTTPS_PROXY/, 'the third is surfaced with a diagnosis')

  // A new step restores the whole budget: the cap is per model request.
  root.emit('session/event', agent.session, { type: 'step/start' })
  assert.deepEqual(await dispatch(), { kind: 'retry' }, 'a new step gets its own grace')

  // A non-transport failure is left to the route policy, budget untouched.
  const other = { ...payload, failure: { code: 'SERVER', message: 'boom' } }
  assert.equal(await root.waterfall('agent/request-error', other, () => Promise.resolve('next')), 'next')
  await root.fiber.dispose()
})

test('the transport budget ignores a route this plugin does not serve', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const root = new Context()
  const llms = makeMockLlms()
  llms.registerAdapter = () => { throw new Error('llm: duplicate adapter for provider "opencode-go"') }
  const { plugin } = await bootPlugin(Context, OpenCodeGoPool, { transportMaxRetries: 0 }, { root, llms })
  assert.equal(plugin.takeoverState(), 'waiting', 'the route is owned elsewhere')

  const action = await root.waterfall('agent/request-error', {
    agent: { session: {} },
    provider: 'opencode-go',
    failure: { code: 'TRANSPORT', message: 'fetch failed' },
    signal: new AbortController().signal,
  }, () => Promise.resolve('downstream'))
  assert.equal(action, 'downstream', 'a dormant plugin leaves transport retries alone')
  await root.fiber.dispose()
})

test('the transport budget never spends a slot on a cancelled turn', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const { root } = await bootPlugin(Context, OpenCodeGoPool,
    { keys: TWO_KEYS, transportMaxRetries: 1 }, { credentials: KEYED_CREDENTIALS })

  const controller = new AbortController()
  controller.abort()
  const action = await root.waterfall('agent/request-error', {
    agent: { session: {} },
    provider: 'opencode-go',
    failure: { code: 'TRANSPORT', message: 'fetch failed' },
    signal: controller.signal,
  }, () => Promise.resolve('downstream'))
  assert.equal(action, 'downstream', 'the user stop wins before the budget')
  await root.fiber.dispose()
})

// The Host validates every business result against its own strict zod schema
// before it crosses the wire, so a payload the schema rejects is a status call
// the card can never see. These two parse the REAL return values.

test('the strict wire schemas accept the real status and usage payloads', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const { TYPERT } = await import('../typert.host.js')
  const schemaFor = method => TYPERT.invocations.find(invocation => invocation.method === method).result.schema

  const calls = stubFetch(t, async () => ({ ok: true, status: 200, json: async () => OK_USAGE }))
  const { root, plugin } = await bootPlugin(Context, OpenCodeGoPool,
    { keys: TWO_KEYS }, { credentials: KEYED_CREDENTIALS })

  // Before the first pass: every key pending, no usage, no error.
  const cold = schemaFor('status').parse(await plugin.status())
  assert.equal(cold.keys[0].usagePending, true)
  assert.equal(cold.keys[0].fetchedAt, null)
  assert.equal(cold.requestTimeoutMs, 300000)
  assert.equal(cold.transportMaxRetries, 5)
  assert.equal(cold.showSidebarQuota, false)

  // After it: the values and the fetch time ride the same rows.
  const usage = schemaFor('usage').parse(await plugin.usage())
  assert.equal(usage.keys[0].usage.rolling.percent, 12)
  assert.equal(usage.keys[0].usagePending, false)
  assert.equal(typeof usage.fetchedAt, 'string')

  const warm = schemaFor('status').parse(await plugin.status())
  assert.equal(warm.keys[0].usage.weekly.percent, 34)
  assert.equal(warm.keys[0].usageError, null)
  assert.equal(typeof warm.keys[0].fetchedAt, 'string')

  // A failure row is part of the same contract. The cache holds the successful
  // values for its TTL, so it is dropped to make the endpoint answer again.
  const failing = stubFetch(t, async () => ({ ok: false, status: 401, json: async () => ({}) }))
  for (const key of TWO_KEYS) plugin.usageCache.invalidate(key.id)
  await plugin.usage()
  const failed = schemaFor('status').parse(await plugin.status())
  assert.equal(failed.keys[0].usageError, 'unauthorized')
  assert.equal(failed.keys[0].usage, null)
  assert.equal(failing.length, 2)
  await root.fiber.dispose()
})

test('puts the pool behind the route the picked-up profile patch configures', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  // The exact shape a real profile carries in its cordis.patch.yml: an
  // explicit config block written BEFORE the advanced fields existed, with
  // non-ASCII labels and hand-written key ids. A schema or pool-validation
  // regression here would take the whole plugin — and with it the profile —
  // down on the next start, so the plugin is booted for real with it.
  const { root, llms, plugin } = await bootPlugin(Context, OpenCodeGoPool, {
    route: 'opencode-go',
    usageBaseUrl: 'https://opencode.ai/zen/go/v1/usage',
    usageRefreshMs: 30000,
    timeoutMs: 15000,
    keys: [
      { id: 'key-muzdpool', label: '小号', apiKeyEnv: 'OPENCODE_GO_KEY_KEY_MUZDPOOL' },
      { id: 'key-muzds1by', label: '大号', apiKeyEnv: 'OPENCODE_GO_KEY_KEY_MUZDS1BY' },
    ],
    preemptAtPercent: 100,
    switchAfterConsecutiveFailures: 0,
    modelMode: 'all',
    models: [],
  })

  assert.deepEqual(llms.registered[0], ['opencode-go'], 'the route is taken over')
  assert.equal(plugin.pool.keyCount(), 2)
  assert.deepEqual(plugin.pool.entries().map(key => key.label), ['小号', '大号'])

  // Fields the profile predates take their defaults rather than reading as
  // undefined, which is what keeps the advanced controls meaningful.
  const status = await plugin.status()
  assert.equal(status.requestTimeoutMs, 300000)
  assert.equal(status.streamIdleTimeoutMs, 300000)
  assert.equal(status.transportMaxRetries, 5)
  assert.equal(status.showSidebarQuota, false)
  assert.equal(status.keys.length, 2)
  assert.equal(status.keys[0].label, '小号')
  assert.equal(status.keys[0].usagePending, true)
  await root.fiber.dispose()
})

test('the shipped bundle patch declares the whole default surface', async (t) => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join: joinPath } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const patch = await readFile(joinPath(here, '..', 'cordis.patch.yml'), 'utf8')
  // The bundle patch is what a profile that never edited its config inherits,
  // so every key the plugin reads has to be named there once.
  for (const key of [
    'route', 'keys', 'preemptAtPercent', 'switchAfterConsecutiveFailures',
    'modelMode', 'models', 'requestTimeoutMs', 'streamIdleTimeoutMs',
    'transportMaxRetries', 'showSidebarQuota', 'usageBaseUrl', 'usageRefreshMs', 'timeoutMs',
  ]) {
    assert.match(patch, new RegExp(`^\\s+${key}:`, 'm'), `the bundle patch declares ${key}`)
  }
})

test('putConfig accepts the advanced network settings and refuses nonsense', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness

  const { root, settings, plugin } = await bootPlugin(Context, OpenCodeGoPool, {})
  await plugin.putConfig({
    requestTimeoutMs: 42000,
    streamIdleTimeoutMs: 9000,
    transportMaxRetries: 8,
    showSidebarQuota: true,
  })
  assert.deepEqual(settings.writes[0].patch, {
    requestTimeoutMs: 42000,
    streamIdleTimeoutMs: 9000,
    transportMaxRetries: 8,
    showSidebarQuota: true,
  })
  const status = await plugin.status()
  assert.equal(status.requestTimeoutMs, 42000)
  assert.equal(status.streamIdleTimeoutMs, 9000)
  assert.equal(status.transportMaxRetries, 8)
  assert.equal(status.showSidebarQuota, true)

  await assert.rejects(() => plugin.putConfig({ requestTimeoutMs: 10 }), /requestTimeoutMs/)
  await assert.rejects(() => plugin.putConfig({ streamIdleTimeoutMs: 99_999_999 }), /streamIdleTimeoutMs/)
  await assert.rejects(() => plugin.putConfig({ transportMaxRetries: 51 }), /transportMaxRetries/)
  await assert.rejects(() => plugin.putConfig({ transportMaxRetries: 1.5 }), /transportMaxRetries/)
  await assert.rejects(() => plugin.putConfig({ showSidebarQuota: 'yes' }), /showSidebarQuota/)
  assert.equal(settings.writes.length, 1, 'a refused write never reaches the settings seam')
  await root.fiber.dispose()
})
