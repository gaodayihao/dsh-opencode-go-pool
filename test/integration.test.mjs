import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFormsSettings } from './fixtures/forms-settings.mjs'

// Real-service integration tests: the plugin runs against the ACTUAL
// LlmRuntime registry and the ACTUAL cordis context/event surface. The
// settings service is the 0.2.1 forms contract double
// (test/fixtures/forms-settings.mjs): `update`/`replace` plus the Loader's
// in-place volatile write and its `loader/volatile-update` announcement, with
// the profile-file persistence of the real service left out. They exercise the
// paths the live host will take: registerAdapter into the real registry,
// providerRetryPolicy capture, LlmRuntime.stream dispatch through the pool
// adapter, putKeys writes through the settings contract, and the takeover
// handshake via the real adapters-updated event. They skip when the harness
// peers are absent.

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
  let Context, LlmRuntime, OpenCodeGoPool, LlmAdapter, createUserMessage
  try {
    ;({ Context } = await import('@deepseek-ai/cordis'))
    ;({ default: LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm'))
    ;({ OpenCodeGoPool } = await import('../index.js'))
    ;({ createUserMessage } = await import('@deepseek-ai/dsh-llm/message'))
  } catch {
    t.skip('harness peer deps not installed — link the DSH node_modules to run integration tests')
    return null
  }
  return { Context, LlmRuntime, OpenCodeGoPool, LlmAdapter, createUserMessage }
}

const TWO_KEYS = [
  { id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
  { id: 'acc-b', label: '备用2', apiKeyEnv: 'OPENCODE_GO_KEY_B' },
]

const quotaFinish = {
  type: 'finish',
  reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota exhausted' } },
}
const successChunks = [
  { type: 'text-delta', index: 0, text: 'hello' },
  { type: 'finish', reason: { kind: 'stop' } },
]

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

/** Build a dummy adapter class off the dynamically imported LlmAdapter base. */
function makeDummyOwner(LlmAdapter) {
  return class extends LlmAdapter {
    async *stream(_options) {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function bootReal(Context, LlmRuntime, OpenCodeGoPool, entryConfig) {
  const root = new Context()
  await root.plugin(LlmRuntime)
  const settings = createFormsSettings(root)
  root.provide('settings', settings.service)
  root.provide('credentials', { resolve: async () => undefined })
  const fiber = await root.plugin(OpenCodeGoPool, entryConfig ?? { keys: TWO_KEYS })
  settings.bind(fiber.config)
  return { root, settings: settings.state, llm: root.get('llm'), plugin: root.get('opencodePool') }
}

test('registers into the real llm registry with the pool retry policy and the pi-ai catalog', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, LlmRuntime, OpenCodeGoPool } = harness
  const { root, llm } = await bootReal(Context, LlmRuntime, OpenCodeGoPool)

  const providers = llm.listProviders()
  const ours = providers.find(p => p.id === 'opencode-go')
  assert.ok(ours, 'opencode-go route registered')
  assert.equal(ours.name, 'OpenCode Zen Go（池）')

  const policy = llm.providerRetryPolicy('opencode-go')
  assert.equal(policy.mode, 'normal')
  assert.ok(policy.retryableCodes.includes('QUOTA'), 'quota joins the retryable codes')

  const models = await llm.listModels('opencode-go')
  assert.ok(models.map(m => m.id).includes('deepseek-v4-flash'))
  await root.fiber.dispose()
})

test('LlmRuntime.stream dispatches through the pool adapter and silent failover', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, LlmRuntime, OpenCodeGoPool, createUserMessage } = harness
  const { root, llm, plugin } = await bootReal(Context, LlmRuntime, OpenCodeGoPool)

  const fake = new FakeInnerAdapter([[quotaFinish], successChunks])
  plugin.makeAttemptAdapter = () => fake

  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })
  const chunks = []
  for await (const chunk of llm.stream({ provider: 'opencode-go', model: 'deepseek-v4-flash', messages: [message] })) {
    chunks.push(chunk)
  }

  const finishes = chunks.filter(c => c.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].reason.kind, 'stop')
  assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'hello'))
  assert.equal(fake.calls, 2)
  assert.equal(plugin.pool.stateOf('acc-a').state, 'exhausted')
  assert.equal(plugin.pool.activeId, 'acc-b')
  await root.fiber.dispose()
})

test('putKeys writes through the settings contract with validation and persistence', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, LlmRuntime, OpenCodeGoPool } = harness
  const { root, settings, plugin } = await bootReal(Context, LlmRuntime, OpenCodeGoPool, { keys: [] })

  await plugin.putKeys([{ id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' }])
  assert.equal(plugin.pool.keyCount(), 1)
  assert.equal(plugin.current().keys.length, 1)
  assert.ok(settings.writes.some(entry => entry.ns === 'opencode-go-pool'), 'section persisted')

  // Shape violation: a non-string apiKeyEnv is refused by the plugin's own key
  // validation before the write reaches the settings service (the real service
  // would reject it a second time against the Config schema).
  await assert.rejects(
    () => plugin.putKeys([{ id: 'acc-a', label: '主号', apiKeyEnv: 12345 }]),
  )
  // Cross-field validation: duplicate env refs refused before any write.
  await assert.rejects(
    () => plugin.putKeys([
      { id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
      { id: 'acc-b', label: '备用', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
    ]),
    /duplicate apiKeyEnv/,
  )
  assert.equal(settings.writes.length, 1, 'refused writes never reach the settings service')
  assert.equal(plugin.pool.keyCount(), 1, 'pool unchanged after refused writes')
  await root.fiber.dispose()
})

test('takeover against the real registry: dormant while owned, auto-registers when released', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, LlmRuntime, OpenCodeGoPool, LlmAdapter } = harness

  const root = new Context()
  await root.plugin(LlmRuntime)
  const settings = createFormsSettings(root)
  root.provide('settings', settings.service)
  root.provide('credentials', { resolve: async () => undefined })

  // Another plugin family owns opencode-go first (pi-ai's posture).
  const owner = new (makeDummyOwner(LlmAdapter))()
  const ownerRegistration = root.get('llm').registerAdapter(['opencode-go'], owner)

  const fiber = await root.plugin(OpenCodeGoPool, { keys: TWO_KEYS })
  settings.bind(fiber.config)
  const plugin = root.get('opencodePool')
  assert.equal(plugin.takeoverState(), 'waiting')

  // The owner releases the route (user deletes the pi-ai row) → the real
  // registry emits adapters-updated → our plugin takes over.
  ownerRegistration()
  assert.equal(plugin.takeoverState(), 'serving')
  const ours = root.get('llm').listProviders().find(p => p.id === 'opencode-go')
  assert.equal(ours.name, 'OpenCode Zen Go（池）')
  await root.fiber.dispose()
})

test('a different route config registers its own route alongside the owner', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, LlmRuntime, OpenCodeGoPool, LlmAdapter } = harness

  const root = new Context()
  await root.plugin(LlmRuntime)
  const settings = createFormsSettings(root)
  root.provide('settings', settings.service)
  root.provide('credentials', { resolve: async () => undefined })

  root.get('llm').registerAdapter(['opencode-go'], new (makeDummyOwner(LlmAdapter))())
  const fiber = await root.plugin(OpenCodeGoPool, { route: 'opencode-go-pool', keys: TWO_KEYS })
  settings.bind(fiber.config)
  const plugin = root.get('opencodePool')
  assert.equal(plugin.takeoverState(), 'own-route')
  const providers = root.get('llm').listProviders()
  assert.ok(providers.some(p => p.id === 'opencode-go'))
  assert.ok(providers.some(p => p.id === 'opencode-go-pool'), 'own route coexists')
  await root.fiber.dispose()
})

test('putKeySecret stores the literal through the credentials seam, never into settings', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, LlmRuntime, OpenCodeGoPool } = harness

  const root = new Context()
  await root.plugin(LlmRuntime)
  const forms = createFormsSettings(root)
  root.provide('settings', forms.service)
  const written = []
  root.provide('credentials', {
    resolve: async () => undefined,
    set: async (ref, value) => { written.push({ ref, value }) },
  })
  const fiber = await root.plugin(OpenCodeGoPool, { keys: TWO_KEYS })
  forms.bind(fiber.config)
  const plugin = root.get('opencodePool')

  await plugin.putKeySecret('acc-a', 'sk-opencode-test-aaaa')
  assert.equal(written.length, 1)
  assert.equal(written[0].value, 'sk-opencode-test-aaaa')
  assert.equal(written[0].ref, 'OPENCODE_GO_KEY_A')
  // The secret never lands in the settings document: no write happened at all.
  assert.deepEqual(forms.state.writes, [], 'putKeySecret never writes settings')
  assert.ok(!JSON.stringify(forms.state.config).includes('sk-opencode-test-aaaa'))

  await assert.rejects(() => plugin.putKeySecret('nope', 'x'), /unknown key/)
  await assert.rejects(() => plugin.putKeySecret('acc-a', '   '), /non-empty secret/)
  await root.fiber.dispose()
})


test('putConfig updates the switching thresholds through the settings service', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, LlmRuntime, OpenCodeGoPool } = harness

  const { root, settings, plugin } = await bootReal(Context, LlmRuntime, OpenCodeGoPool)

  await plugin.putConfig({ preemptAtPercent: 80, switchAfterConsecutiveFailures: 3 })
  const status = await plugin.status()
  assert.equal(status.preemptAtPercent, 80)
  assert.equal(status.switchAfterConsecutiveFailures, 3)
  assert.deepEqual(settings.writes.at(-1), {
    ns: 'opencode-go-pool',
    patch: { preemptAtPercent: 80, switchAfterConsecutiveFailures: 3 },
  })
  await assert.rejects(() => plugin.putConfig({ preemptAtPercent: 250 }), /0\.\.100/)
  await assert.rejects(() => plugin.putConfig({}), /no known fields/)
  await root.fiber.dispose()
})

test('model selection filters the catalog and gates disabled models through the real seams', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, LlmRuntime, OpenCodeGoPool } = harness
  const { root, llm, plugin } = await bootReal(Context, LlmRuntime, OpenCodeGoPool)

  // Default: 'all' mode exposes the whole catalog to the picker and status.
  let status = await plugin.status()
  assert.equal(status.modelMode, 'all')
  assert.ok(status.availableModels.length >= 2, 'catalog present in the card data')
  assert.ok(status.availableModels.every(m => m.enabled), 'all models enabled by default')

  // Custom selection: only the chosen model survives everywhere.
  await plugin.putConfig({ modelMode: 'custom', models: ['deepseek-v4-pro', 'deepseek-v4-pro'] })
  status = await plugin.status()
  assert.equal(status.modelMode, 'custom')
  assert.deepEqual(
    status.availableModels.filter(m => m.enabled).map(m => m.id),
    ['deepseek-v4-pro'],
    'status dedupes and reports only the selected model as enabled',
  )

  const models = await llm.listModels('opencode-go')
  assert.deepEqual(models.map(m => m.id), ['deepseek-v4-pro'], 'model dropdown sees only the selected model')

  await assert.rejects(
    () => plugin.poolAdapter.resolveModel('opencode-go', 'glm-5.2'),
    err => err && err.code === 'UNKNOWN_MODEL',
    'a disabled model is refused with UNKNOWN_MODEL',
  )

  // Back to 'all' restores the complete catalog.
  await plugin.putConfig({ modelMode: 'all' })
  const allAgain = await llm.listModels('opencode-go')
  assert.ok(allAgain.map(m => m.id).includes('glm-5.2'), 'all-mode restores the full catalog')

  // Validation: an empty custom selection and a bogus mode are refused.
  await assert.rejects(() => plugin.putConfig({ modelMode: 'custom', models: [] }), /at least one model/)
  await assert.rejects(() => plugin.putConfig({ modelMode: 'none' }), /"all" or "custom"/)
  await assert.rejects(() => plugin.putConfig({ models: ['ok', 42] }), /non-empty model ids/)
  await root.fiber.dispose()
})

test('fetched dynamic models merge into the catalog and resolve end-to-end', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, LlmRuntime, OpenCodeGoPool } = harness
  const { root, llm, plugin } = await bootReal(Context, LlmRuntime, OpenCodeGoPool)

  // A supplier model the shipped catalog does not yet carry, pulled by the
  // refreshModels action. Mutating the cache exercises the wrapper provider
  // without any network.
  plugin.dynamicModels.set('glm-5.3', { id: 'glm-5.3', name: 'GLM-5.3' })

  const ids = (await llm.listModels('opencode-go')).map(m => m.id)
  assert.ok(ids.includes('glm-5.3'), 'the fetched model appears in the picker catalog')

  const status = await plugin.status()
  const fetched = status.availableModels.find(m => m.id === 'glm-5.3')
  assert.ok(fetched, 'the fetched model appears in the card data')
  assert.equal(fetched.dynamic, true, 'the fetched model is flagged dynamic')
  assert.equal(fetched.enabled, true, 'all-mode enables the fetched model too')

  // The fetched model resolves (routed with a default protocol) rather than
  // raising UNKNOWN_MODEL.
  const resolved = await plugin.poolAdapter.resolveModel('opencode-go', 'glm-5.3')
  assert.equal(resolved.id, 'glm-5.3')
  await root.fiber.dispose()
})
