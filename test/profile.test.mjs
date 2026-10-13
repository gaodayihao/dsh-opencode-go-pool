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

// ---- completion-budget reservation -----------------------------------------
//
// `dsh-compaction-basic` sizes its automatic compaction threshold as
//
//   min(contextWindow × thresholdRatio, contextWindow − reserved − headroom)
//
// where `reserved` is the adapter's `defaultMaxTokens`, and llm-pi-ai publishes
// exactly that from this profile's `configuredMaxTokens` map. An empty map made
// `reserved` 0 and the threshold `contextWindow × 0.8` = 800000.
//
// The descriptors this route serves put their own `maxTokens` on the wire as
// `max_tokens` (384000 on every DeepSeek model here), and the gateway rejects
// `prompt + max_tokens > 1,048,576` — so the real prompt ceiling is 664576, i.e.
// 135424 tokens BELOW the threshold the harness believed in. A session that grew
// into that gap got `HTTP 400` on every request; when the gateway forwarded no
// error body the harness read it as `400 status code (no body)`, could not
// classify it as a context overflow, and neither automatic compaction trigger
// fired — the session was stuck for good and subagent sessions, which have no
// `/compact`, could not be rescued at all. Regression: sessions died at prompt
// 664086 / 664277 / 665115 / 665815 / 666412 on DSH 0.2.0-rc.2.

test("the profile reserves each served model's own completion budget", async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { buildProfile } = harness
  const profile = buildProfile(route, () => [])
  const budgets = profile.configuredMaxTokens

  assert.ok(budgets instanceof Map, 'still the Map llm-pi-ai reads')
  assert.equal(budgets.get('deepseek-v4.1-flash'), 384000, 'the model this regression is about reserves 384000')
  assert.equal(budgets.get('glm-5.1'), 32768, 'a model with a small cap reports its own number')
  assert.equal(budgets.get('no-such-model'), undefined, 'an unserved id declares nothing')
  assert.equal(budgets.has('deepseek-v4.1-flash'), true)
  assert.equal(budgets.has('no-such-model'), false)
  assert.equal(budgets.size, profile.piProvider.getModels().length, 'every served model declares its budget')

  // The arithmetic the fix exists for, on the shipped numbers.
  const contextWindow = 1000000
  const headroomTokens = 65536
  const gatewayCeiling = 1048576
  const promptCeiling = gatewayCeiling - budgets.get('deepseek-v4.1-flash')
  const threshold = (reserved) => Math.floor(Math.min(
    contextWindow * 0.8,
    contextWindow - reserved - headroomTokens,
  ))
  assert.equal(promptCeiling, 664576)
  assert.equal(threshold(0), 800000, 'an empty map put the threshold here')
  assert.equal(threshold(384000), 550464, 'a reserved budget puts it here')
  assert.ok(threshold(0) > promptCeiling, 'the empty map left the threshold above the real prompt ceiling')
  assert.ok(threshold(384000) < promptCeiling, 'the reserved budget keeps it below')
})

test('the completion-budget view follows the served catalog and tolerates a malformed cap', async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { buildProfile } = harness
  let dynamicModelDescriptor
  try {
    ;({ dynamicModelDescriptor } = await import('../models.js'))
  } catch {
    t.skip('../models.js is not importable')
    return
  }

  // refreshModels() appends fetched descriptors to the provider WITHOUT
  // rebuilding the profile, so a snapshot taken at build time would go back to
  // reserving nothing for every model fetched afterwards.
  const fetched = []
  const profile = buildProfile(route, () => fetched.map(entry => dynamicModelDescriptor(entry.id, entry.name, route)))
  assert.equal(profile.configuredMaxTokens.get('late-model'), undefined, 'nothing fetched yet')
  fetched.push({ id: 'late-model', name: 'Late Model' })
  assert.equal(profile.configuredMaxTokens.get('late-model'), 131072, 'a fetched model is picked up without a rebuild')
  assert.equal(profile.configuredMaxTokens.size, profile.piProvider.getModels().length)

  // normalizeModelInfo throws INVALID_MODEL_MAX_TOKENS on a bad value, which
  // would break every request on the route, so a malformed cap must answer
  // "no declared budget" instead of reaching the adapter.
  const broken = buildProfile(route, () => [{ id: 'zero-cap', maxTokens: 0 }])
  assert.equal(broken.configuredMaxTokens.get('zero-cap'), undefined)
  const texty = buildProfile(route, () => [{ id: 'texty-cap', maxTokens: '131072' }])
  assert.equal(texty.configuredMaxTokens.get('texty-cap'), undefined)
})

test('the installed PiAiAdapter publishes the reserved budget as defaultMaxTokens', async (t) => {
  const harness = await loadProfile(t)
  if (harness === null) return
  const { buildProfile, PiAiAdapter, createPiAiAuth } = harness
  const profile = buildProfile(route, () => [])
  const adapter = new PiAiAdapter({
    profiles: () => new Map([[route, profile]]),
    resolveApiKey: async () => { throw new Error('the catalog adapter never resolves keys') },
    auth: createPiAiAuth({ get: () => undefined }),
    resolveAttachments: () => undefined,
  })

  const resolve = async (id) => (typeof adapter.prepareCall === 'function'
    ? (await adapter.prepareCall(route, id)).model
    : await adapter.resolveModel(route, id))

  const flash = await resolve('deepseek-v4.1-flash')
  assert.equal(flash.defaultMaxTokens, 384000, 'llm-pi-ai reports the number compaction must reserve')
  assert.equal(flash.context.contextWindow, 1000000)

  const glm = await resolve('glm-5.1')
  assert.equal(glm.defaultMaxTokens, 32768, 'the cap is per model, not one route-wide constant')
  assert.equal(glm.context.contextWindow, 202752)
})

