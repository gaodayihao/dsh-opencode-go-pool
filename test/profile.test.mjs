import assert from 'node:assert/strict'
import test from 'node:test'

// Regression: llm-pi-ai's PiAiAdapter resolves a hand-built profile on every
// model query. Its modelOf() reads `profile.modelErrors` before it resolves any
// model, so a profile that omits the map throws
// "Cannot read properties of undefined (reading 'get')" for every
// resolveModel/resolveModelInfo/stream — which surfaced as a failed model group
// in the model picker and as a failed agent turn ("本轮运行失败"). The plugin
// owns the route directly, so it has to supply the whole resolved profile.
//
// 0.2.1 also made the adapter's `auth` option mandatory (a collection without
// it gets pi-ai's empty in-memory store), and the plugin's own createPiAiAuth()
// supplies the records-free injection this adapter family needs.
//
// The unit assertions below pin the fields; the adapter check runs the real
// installed adapter, which catches the crash on any release that reads them.

async function loadProfile(t) {
  let buildProfile, resolveRetryPolicy, PiAiAdapter, createPiAiAuth, withExplicitThinkingOff
  try {
    ;({ buildProfile, createPiAiAuth, withExplicitThinkingOff } = await import('../index.js'))
    ;({ resolveRetryPolicy } = await import('@deepseek-ai/dsh-llm'))
    ;({ PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai'))
  } catch {
    t.skip('harness peer deps not installed — link the DSH node_modules to run the profile tests')
    return null
  }
  return { buildProfile, resolveRetryPolicy, PiAiAdapter, createPiAiAuth, withExplicitThinkingOff }
}

const route = 'opencode-go'

test('the hand-built profile carries every adapter-owned field', async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { buildProfile, resolveRetryPolicy } = harness
  const descriptor = {
    id: 'brand-new-model',
    name: 'Brand New Model',
    provider: route,
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 131072,
  }
  const profile = buildProfile(route, () => [descriptor])

  assert.equal(profile.provider, route)
  assert.equal(typeof profile.displayName, 'string')
  assert.ok(profile.piProvider, 'the profile carries the wrapped catalog provider')
  // modelOf() reads this map before resolving any model.
  assert.ok(profile.modelErrors instanceof Map, 'modelErrors is a Map')
  assert.equal(profile.modelErrors.size, 0, 'the catalog route declares no per-model failures')
  assert.ok(profile.configuredMaxTokens instanceof Map)
  assert.ok(Number.isSafeInteger(profile.streamIdleTimeoutMs) && profile.streamIdleTimeoutMs > 0)
  for (const field of ['maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes']) {
    assert.ok(Number.isSafeInteger(profile[field]) && profile[field] > 0, `${field} is a positive integer`)
  }
  assert.deepEqual(profile.retryPolicy, resolveRetryPolicy(undefined, 'opencode-go-pool.catalog.retryPolicy'))

  const ids = profile.piProvider.getModels().map(model => model.id)
  assert.ok(ids.includes('brand-new-model'), 'fetched descriptors are appended to the catalog')
})

test('the two card-editable network timeouts land in the resolved profile', async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { buildProfile } = harness

  // llm-pi-ai hands `profile.timeoutMs` straight to pi-ai's own stream options
  // and wraps the stream in `idleWatchdog(..., profile.streamIdleTimeoutMs)`, so
  // these two fields ARE the advanced settings taking effect.
  const tuned = buildProfile(route, () => [], { requestTimeoutMs: 42000, streamIdleTimeoutMs: 9000 })
  assert.equal(tuned.timeoutMs, 42000, 'request timeout rides pi-ai request timeout')
  assert.equal(tuned.streamIdleTimeoutMs, 9000, 'stream idle timeout rides the adapter watchdog')

  const defaults = buildProfile(route, () => [])
  assert.equal(defaults.timeoutMs, 300000)
  assert.equal(defaults.streamIdleTimeoutMs, 300000)
})

test('the installed PiAiAdapter resolves a model from the hand-built profile', async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { buildProfile, PiAiAdapter, createPiAiAuth } = harness
  const fetched = [{ id: 'brand-new-model', name: 'Brand New Model' }]
  const profile = buildProfile(route, () => fetched.map(model => ({
    id: model.id,
    name: model.name,
    provider: route,
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 131072,
  })))
  const adapter = new PiAiAdapter({
    profiles: () => new Map([[route, profile]]),
    resolveApiKey: async () => { throw new Error('the catalog adapter never resolves keys') },
    auth: createPiAiAuth({ get: () => undefined }),
    resolveAttachments: () => undefined,
  })

  const models = await adapter.listModels(route)
  const fetchedModel = models.find(model => model.id === 'brand-new-model')
  assert.ok(fetchedModel, 'listModels includes the fetched model')
  // 0.1.7 renamed this path prepareCall; older releases resolve through
  // resolveModel. Both go through the profile's modelErrors read.
  const resolved = typeof adapter.prepareCall === 'function'
    ? (await adapter.prepareCall(route, fetchedModel.id)).model
    : await adapter.resolveModel(route, fetchedModel.id)
  assert.equal(resolved.id, fetchedModel.id, 'the adapter resolves the model through the profile')
})

test('createPiAiAuth declares no pi-ai credential records and refuses writes', async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { createPiAiAuth } = harness
  const ctx = {
    get: (name) => (name === 'credentials'
      ? { resolve: async () => ({ value: 'sk-from-seam' }) }
      : undefined),
  }
  const auth = createPiAiAuth(ctx)

  assert.equal(await auth.credentials.read(route), undefined, 'reads answer "nothing stored"')
  assert.deepEqual(await auth.credentials.list(), [], 'no records are listed')
  await assert.rejects(
    () => auth.credentials.modify(route, async () => undefined),
    /apiKeyEnv/,
    'a write that cannot land must not report success',
  )
  await auth.credentials.delete(route)

  assert.equal(await auth.authContext.env('OPENCODE_GO_KEY_A'), 'sk-from-seam', 'references resolve through the seam')
  assert.equal(await auth.authContext.env('not-a-reference'), process.env['not-a-reference'])
  assert.equal(await auth.authContext.fileExists('~'), true, 'the home directory exists')
  assert.equal(await auth.authContext.fileExists('~/.definitely-missing-dsh-probe'), false)
})

// ---- thinking-off restoration ---------------------------------------------
//
// pi-ai's `openai-completions` builder emits `thinking: { type: 'disabled' }`
// only while `model.thinkingLevelMap.off !== null`; a null `off` sends no
// thinking control at all and the Go gateway then reasons by default. The
// harness's auxiliary calls are exactly the shape that breaks: `purpose:
// 'session-title'` dispatches with maxOutputTokens 64 and no reasoning effort,
// because the official DeepSeek adapter maps that purpose to thinking-disabled.
// Measured against the live gateway on 2026-10-09 with deepseek-v4.1-flash and
// max_tokens 64: no thinking control finished `length` with 0 characters of
// text and 64 reasoning tokens, while the same body plus
// `thinking: { type: 'disabled' }` finished `stop` with the answer and 0
// reasoning tokens. Every session therefore kept its deterministic fallback
// title (the opening words of its first message) instead of a generated one.

const deepseekDescriptor = {
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek V4.1 Flash',
  provider: route,
  api: 'openai-completions',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
  compat: { supportsStore: false, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' },
  contextWindow: 1000000,
  maxTokens: 384000,
}

test('drops a null DeepSeek off so pi-ai can send thinking disabled', async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { withExplicitThinkingOff } = harness

  const normalized = withExplicitThinkingOff(deepseekDescriptor)
  assert.ok(!('off' in normalized.thinkingLevelMap), 'the null off is gone')
  assert.equal(normalized.thinkingLevelMap.high, 'high', 'every other level survives')
  assert.equal(deepseekDescriptor.thinkingLevelMap.off, null, 'the shipped descriptor is not mutated')

  // Only the off-spelling this gateway is known to accept is rewritten.
  const otherFormat = { ...deepseekDescriptor, compat: { thinkingFormat: 'qwen' } }
  assert.equal(withExplicitThinkingOff(otherFormat), otherFormat, 'another thinking format keeps its own off')
  const alreadySpelled = { ...deepseekDescriptor, thinkingLevelMap: { off: 'none', high: 'high' } }
  assert.equal(withExplicitThinkingOff(alreadySpelled), alreadySpelled, 'a real off spelling is left alone')
  const noMap = { ...deepseekDescriptor, reasoning: false, thinkingLevelMap: undefined }
  assert.equal(withExplicitThinkingOff(noMap), noMap, 'a descriptor without a level map passes through')
})

test('the served catalog normalizes the shipped model and offers a real Off', async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { buildProfile, withExplicitThinkingOff } = harness
  let getSupportedThinkingLevels
  try {
    ;({ getSupportedThinkingLevels } = await import('@earendil-works/pi-ai'))
  } catch {
    t.skip('@earendil-works/pi-ai is not installed')
    return
  }

  // Baseline: the levels pi-ai derives from a null off hide "Off" entirely,
  // which is why the picker never offered a way not to think.
  assert.ok(!getSupportedThinkingLevels(deepseekDescriptor).includes('off'), 'a null off hides the level')
  assert.ok(
    getSupportedThinkingLevels(withExplicitThinkingOff(deepseekDescriptor)).includes('off'),
    'the normalized model offers it',
  )

  const served = buildProfile(route, () => []).piProvider.getModels()
  for (const model of served) {
    if (model.compat?.thinkingFormat === 'deepseek') {
      assert.notEqual(model.thinkingLevelMap?.off, null, `${model.id} carries no null DeepSeek off`)
    }
  }
  const shipped = served.find(model => model.id === 'deepseek-v4.1-flash')
  assert.ok(shipped, 'the installed catalog ships the flash model this regression is about')
  assert.ok(!('off' in shipped.thinkingLevelMap), 'the shipped flash model is normalized in the served catalog')
})
