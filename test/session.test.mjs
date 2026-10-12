import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFormsSettings } from './fixtures/forms-settings.mjs'

import { OPENCODE_SESSION_HEADER, SessionIdTracker, withSessionId } from '../session.js'

// Regression: OpenCode Go answers HTTP 400 `MissingSessionID` ("Request is
// missing x-opencode-session and cannot be routed efficiently") when a request
// carries no session id, and pi-ai derives that header from the `sessionId`
// field of its stream options. `dsh-llm-pi-ai` fills the field from the
// harness's `GenerateOptions.sessionId`, which the agent loop sets on its own
// requests and auxiliary callers do not — the Auto permission preset's reviewer
// (`@deepseek-ai/dsh-experimental-auto-review`) dispatches with
// provider/model/system/messages/temperature/signal only, so every reviewed
// tool call failed before its body ran.
//
// Measured against the live gateway on 2026-10-09 with `deepseek-v4.1-flash`:
// no header → 400 MissingSessionID; the same body plus
// `x-opencode-session: <any non-empty string>` → 200 (a random UUID and an
// arbitrary `ses_…` string both worked, an empty value did not).
//
// These tests pin the plugin's side of that contract: the tracker, the copy
// semantics frozen callers need, and the real SDK's wire request.

// ---- the dependency-free tracker ------------------------------------------

test('the harness session id wins and is remembered for session-less calls', () => {
  const tracker = new SessionIdTracker('fallback-id')
  assert.equal(tracker.idFor({ sessionId: 'session-main' }), 'session-main')
  assert.equal(tracker.idFor({}), 'session-main', 'an auxiliary call reuses the conversation id')
  assert.equal(tracker.idFor({ sessionId: 'session-next' }), 'session-next')
  assert.equal(tracker.idFor({}), 'session-next', 'the newest id is the remembered one')
})

test('a request with no usable id gets the stable per-process id', () => {
  const tracker = new SessionIdTracker('fallback-id')
  assert.equal(tracker.idFor({}), 'fallback-id', 'nothing has been seen yet')
  assert.equal(tracker.idFor({ sessionId: '' }), 'fallback-id', 'an empty value is as good as absent')
  assert.equal(tracker.idFor({ sessionId: undefined }), 'fallback-id')
  assert.equal(tracker.idFor({ sessionId: 42 }), 'fallback-id', 'a non-string is not a session id')
  assert.equal(tracker.idFor(undefined), 'fallback-id')
  assert.equal(tracker.idFor({ sessionId: '' }), 'fallback-id', 'the fallback never drifts')
})

test('withSessionId copies instead of mutating, and never copies needlessly', () => {
  const frozen = Object.freeze({
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    messages: Object.freeze([]),
  })
  const patched = withSessionId(frozen, 'session-1')
  assert.notEqual(patched, frozen, 'a frozen request cannot be patched in place')
  assert.equal(patched.sessionId, 'session-1')
  assert.equal('sessionId' in frozen, false, 'the caller request object is untouched')
  assert.equal(patched.provider, frozen.provider, 'every other field survives the copy')

  const named = { provider: 'opencode-go', sessionId: 'session-1' }
  assert.equal(withSessionId(named, 'session-1'), named, 'an already-named request is dispatched as-is')
})

test('the header name is the one OpenCode Go documents', () => {
  assert.equal(OPENCODE_SESSION_HEADER, 'x-opencode-session')
})

// ---- the plugin over mocked seams -----------------------------------------

// Cordis smoke tests. They exercise the real plugin against mocked seams, but
// need the DeepSeek Harness peer dependencies installed. In a checkout that
// does not have them (e.g. `node --test` on a fresh clone), every test skips
// instead of failing.

/** Point DSH_HOME at a fresh temp dir so tests never touch the real state file. */
function isolateHome(t) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-opencode-go-pool-session-'))
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
    t.skip('harness peer deps not installed — link the DSH node_modules to run the session tests')
    return null
  }
  return { Context, OpenCodeGoPool }
}

const ONE_KEY = [{ id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' }]
const DUMMY_KEY = 'sk-test-placeholder-aaaa'

async function bootPlugin(Context, OpenCodeGoPool, rawConfig) {
  const root = new Context()
  const llms = {
    registered: [],
    adapter: null,
    registerAdapter(routes, adapter) {
      this.registered.push([...routes])
      this.adapter = adapter
      return { replace: next => { this.registered.push([...next]) } }
    },
  }
  const settings = createFormsSettings(root)
  root.provide('llm', llms)
  root.provide('settings', settings.service)
  root.provide('credentials', { resolve: async () => ({ value: DUMMY_KEY }) })
  const fiber = await root.plugin(OpenCodeGoPool, rawConfig)
  settings.bind(fiber.config)
  return { root, llms, plugin: root.get('opencodePool') }
}

/** Replace the per-attempt adapter with a spy that records the request it is handed. */
function captureRequests(plugin) {
  const seen = []
  plugin.makeAttemptAdapter = () => ({
    async *stream(options) {
      seen.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  return seen
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('a session-less auxiliary request reaches the provider with a session id', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness
  const { root, llms, plugin } = await bootPlugin(Context, OpenCodeGoPool, { keys: ONE_KEY })
  const seen = captureRequests(plugin)

  const options = {
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  await drain(llms.adapter.stream(options))
  await drain(llms.adapter.stream({ ...options }))

  assert.equal(seen.length, 2)
  assert.equal(typeof seen[0].sessionId, 'string')
  assert.ok(seen[0].sessionId.length > 0, 'the provider never receives an empty session id')
  assert.equal(seen[1].sessionId, seen[0].sessionId, 'the synthesized id is stable for the process')
  assert.equal('sessionId' in options, false, 'the caller request object is never mutated')
  await root.fiber.dispose()
})

test('the harness id wins and rides the auxiliary call that follows it', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness
  const { root, llms, plugin } = await bootPlugin(Context, OpenCodeGoPool, { keys: ONE_KEY })
  const seen = captureRequests(plugin)

  const loopRequest = {
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    sessionId: 'session-main',
  }
  await drain(llms.adapter.stream(loopRequest))
  await drain(llms.adapter.stream({
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'review' }] }],
  }))

  assert.equal(seen[0].sessionId, 'session-main', 'the harness id is passed through')
  assert.equal(seen[0], loopRequest, 'a loop request is dispatched unchanged, not copied')
  assert.equal(seen[1].sessionId, 'session-main', 'the auxiliary call reuses the conversation id')
  await root.fiber.dispose()
})

test('a deep-frozen auxiliary request is copied, never mutated', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness
  const { root, llms, plugin } = await bootPlugin(Context, OpenCodeGoPool, { keys: ONE_KEY })
  const seen = captureRequests(plugin)

  // The shape dsh-experimental-auto-review dispatches: deepFreeze() over the
  // whole options object, so assigning sessionId in place would throw.
  const frozen = Object.freeze({
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    system: 'REVIEW_POLICY',
    messages: Object.freeze([Object.freeze({
      role: 'user',
      content: Object.freeze([Object.freeze({ type: 'text', text: 'pending action' })]),
    })]),
    temperature: 0,
    signal: new AbortController().signal,
  })

  const chunks = await drain(llms.adapter.stream(frozen))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.ok(seen[0].sessionId.length > 0)
  assert.equal('sessionId' in frozen, false, 'the frozen request is left exactly as the caller built it')
  assert.equal(seen[0].system, 'REVIEW_POLICY', 'the copy keeps the reviewer policy')
  await root.fiber.dispose()
})

// ---- the real SDK on the wire ---------------------------------------------

/** Lowercased header map out of whatever the SDK hands its fetch. */
function headerMap(headers) {
  if (headers === undefined || headers === null) return {}
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries())
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
}

/** A minimal OpenAI-compatible SSE completion, enough for pi-ai to finish. */
const SSE_BODY = [
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"deepseek-v4-flash",'
    + '"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"deepseek-v4-flash",'
    + '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
    + '"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
  '',
  'data: [DONE]',
  '',
].join('\n')

test('the wire request carries x-opencode-session, from the harness id and without one', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { Context, OpenCodeGoPool } = harness
  const { root, llms } = await bootPlugin(Context, OpenCodeGoPool, { keys: ONE_KEY })

  const calls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: headerMap(init?.headers) })
    return new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  t.after(() => { globalThis.fetch = previousFetch })

  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  try {
    // 1. The harness's own loop request: its id must reach the wire verbatim.
    await drain(llms.adapter.stream({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      messages,
      sessionId: 'session-wire',
    }))
    // 2. The auxiliary shape (no sessionId), which is what 400'd before.
    await drain(llms.adapter.stream({ provider: 'opencode-go', model: 'deepseek-v4-flash', messages }))
  } finally {
    globalThis.fetch = previousFetch
  }

  assert.equal(calls.length, 2, 'one provider request per stream')
  for (const call of calls) assert.match(call.url, /opencode\.ai\/zen\/go/)
  assert.equal(calls[0].headers[OPENCODE_SESSION_HEADER], 'session-wire')
  assert.equal(calls[1].headers[OPENCODE_SESSION_HEADER], 'session-wire',
    'the auxiliary request rides the conversation it belongs to')
  assert.match(calls[0].headers['user-agent'], /deepseek-harness/,
    'OpenCode Go also asks clients to identify themselves')
  await root.fiber.dispose()
})
