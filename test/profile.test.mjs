import assert from 'node:assert/strict'
import test from 'node:test'

// Regression: llm-pi-ai's PiAiAdapter resolves a hand-built profile on every
// model query. Its 0.1.7 release reads `profile.modelErrors` inside modelOf(),
// so a profile that omits the map throws
// "Cannot read properties of undefined (reading 'get')" for every
// resolveModel/resolveModelInfo/stream — which surfaced as a failed model group
// in the model picker and as a failed agent turn ("本轮运行失败"). The plugin
// owns the route directly, so it has to supply the whole resolved profile.
//
// The unit assertions below pin the fields; the adapter check runs the real
// installed adapter, which catches the crash on any release that reads them.

async function loadProfile(t) {
  let buildProfile, resolveRetryPolicy, PiAiAdapter
  try {
    ;({ buildProfile } = await import('../index.js'))
    ;({ resolveRetryPolicy } = await import('@deepseek-ai/dsh-llm'))
    ;({ PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai'))
  } catch {
    t.skip('harness peer deps not installed — link the DSH node_modules to run the profile tests')
    return null
  }
  return { buildProfile, resolveRetryPolicy, PiAiAdapter }
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

test('the installed PiAiAdapter resolves a model from the hand-built profile', async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { buildProfile, PiAiAdapter } = harness
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
