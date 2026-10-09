import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TRANSPORT_MAX_RETRIES,
  MAX_TRANSPORT_MAX_RETRIES,
  TRANSPORT_FAILURE_CODE,
  TransportBudget,
  transportBudgetMessage,
  transportResetAction,
} from '../transport.js'

// The advanced setting `网络失败重试次数` is only "真实可用" if a TRANSPORT
// failure is actually bounded by it. Two things have to hold together:
//
//   1. the route policy must NOT list TRANSPORT (it is captured once per route
//      and shares its attempt window with the quota window, which is minutes
//      long by design) — otherwise the official retrier answers first and the
//      budget is never consulted;
//   2. the plugin's agent/request-error listener answers TRANSPORT from the
//      budget and surfaces the failure with a diagnosis once it is spent.
//
// These tests pin the budget itself and the reset points. The route policy
// shape and the listener wiring are pinned by test/smoke.test.mjs, which boots
// the real plugin over mocked seams.

test('transport credentials: the budget retries, then refuses', () => {
  const budget = new TransportBudget()
  const agent = {}
  assert.equal(budget.absorb(agent, 'SERVER', 3), 'ignored', 'other codes belong to the route policy')
  assert.equal(budget.absorb(agent, TRANSPORT_FAILURE_CODE, 0), 'exhausted', 'a 0 budget never retries')
  assert.equal(budget.used(agent), 0, 'a refusal does not consume a slot')

  const counted = new TransportBudget()
  assert.equal(counted.absorb(agent, TRANSPORT_FAILURE_CODE, 3), 'retry')
  assert.equal(counted.absorb(agent, TRANSPORT_FAILURE_CODE, 3), 'retry')
  assert.equal(counted.absorb(agent, TRANSPORT_FAILURE_CODE, 3), 'retry')
  assert.equal(counted.absorb(agent, TRANSPORT_FAILURE_CODE, 3), 'exhausted')
  assert.equal(counted.used(agent), 3)

  counted.reset(agent)
  assert.equal(counted.used(agent), 0, 'a new step restores the whole budget')
  assert.equal(counted.absorb(agent, TRANSPORT_FAILURE_CODE, 3), 'retry')
})

test('transport credentials: the budget is per agent, never shared', () => {
  const budget = new TransportBudget()
  const first = {}
  const second = {}
  assert.equal(budget.absorb(first, TRANSPORT_FAILURE_CODE, 1), 'retry')
  assert.equal(budget.absorb(first, TRANSPORT_FAILURE_CODE, 1), 'exhausted')
  assert.equal(budget.absorb(second, TRANSPORT_FAILURE_CODE, 1), 'retry', 'a concurrent turn has its own grace')
})

test('transport credentials: degenerate agents are ignored, not counted', () => {
  const budget = new TransportBudget()
  assert.equal(budget.absorb(undefined, TRANSPORT_FAILURE_CODE, 3), 'ignored')
  assert.equal(budget.absorb(null, TRANSPORT_FAILURE_CODE, 3), 'ignored')
  budget.reset(undefined)
  assert.equal(budget.used(undefined), 0)
})

test('the reset point is a new step, and turn/end forgets the session', () => {
  assert.equal(transportResetAction('step/start'), 'reset')
  assert.equal(transportResetAction('turn/end'), 'forget')
  // Deliberately NOT reset points: `assistant/attempt` is appended for the
  // FAILED attempt before agent/request-error dispatches, and a turn's steps
  // share one `running` status, so neither can bound anything.
  assert.equal(transportResetAction('assistant/attempt'), 'none')
  assert.equal(transportResetAction('step/end'), 'none')
  assert.equal(transportResetAction('llm/retry'), 'none')
})

test('the spent-budget diagnosis names the budget and the real cause', () => {
  const message = transportBudgetMessage('fetch failed', 4)
  assert.match(message, /fetch failed/)
  assert.match(message, /4/)
  assert.match(message, /HTTPS_PROXY/)
  assert.match(message, /opencode\.ai/)
})

test('the shipped defaults and ceilings are the documented ones', () => {
  assert.equal(DEFAULT_TRANSPORT_MAX_RETRIES, 5)
  assert.equal(MAX_TRANSPORT_MAX_RETRIES, 50)
})
