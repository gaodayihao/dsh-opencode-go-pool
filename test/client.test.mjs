import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Client-bundle execution tests: the bundle is actually EXECUTED (window stub +
// react), apply() runs against a mock slot/locale/remote context, and the
// captured surfaces are server-rendered. They skip when react/react-dom are
// absent (fresh clone without the DSH node_modules).

const here = dirname(fileURLToPath(import.meta.url))
const clientUrl = pathToFileURL(join(here, '..', 'client.js')).href

async function loadReact(t) {
  let React, renderToString
  try {
    React = (await import('react')).default
    ;({ renderToString } = await import('react-dom/server'))
  } catch {
    t.skip('react/react-dom not installed')
    return null
  }
  return { React, renderToString }
}

/** Execute the bundle under a window stub; returns its module exports. */
async function loadClientBundle(t) {
  let spec
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load: entry => { spec = entry },
    },
  }
  try {
    // Cache-busting query: each test gets a fresh evaluation of the bundle.
    await import(`${clientUrl}?case=${Date.now()}-${Math.random()}`)
  } finally {
    globalThis.window = previousWindow
  }
  assert.ok(spec, 'bundle registers its factory')
  assert.equal(spec.id, 'dsh-opencode-go-pool')
  return spec
}

function instantiate(spec, React, extraRequires = {}) {
  return spec.factory(name => {
    if (name === 'react') return React
    if (name in extraRequires) return extraRequires[name]
    throw new Error(`unexpected require: ${name}`)
  })
}

/** A store stub good enough for a server render: no effects ever run. */
function stubStore(data) {
  const state = { data, error: null, failures: 0, loading: false, busy: null, notice: null, loadedAt: null, usageAt: null, pollMs: 30000 }
  return {
    get: () => state,
    subscribe: () => () => {},
    retain: () => () => {},
    probeOnce: async () => {},
    refresh: () => {},
    run: async () => true,
    remote: async () => null,
    setNotice: () => {},
    clearNotice: () => {},
    dispose: () => {},
  }
}

const POOL_STATUS = {
  takeover: 'serving',
  route: 'opencode-go',
  usageRefreshMs: 30000,
  preemptAtPercent: 100,
  switchAfterConsecutiveFailures: 0,
  requestTimeoutMs: 300000,
  streamIdleTimeoutMs: 300000,
  transportMaxRetries: 5,
  showSidebarQuota: false,
  modelMode: 'all',
  availableModels: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true, dynamic: false }],
  activeId: 'acc-a',
  lastSwitch: null,
  takeoverHint: null,
  settingsAvailable: true,
  settingsHint: null,
  usageRefreshing: false,
  keys: [],
}

/** The staged snapshot a section renders from, plus its parsed reading. */
function stagedFor(module, data) {
  const available = Array.isArray(data.availableModels) ? data.availableModels : []
  const current = module.__test.stagedConfig(data, available)
  return { current, reading: module.__test.readStaged(current) }
}

const KEY = {
  id: 'acc-a',
  label: '主号',
  apiKeyEnv: 'OPENCODE_GO_KEY_A',
  state: 'healthy',
  active: true,
  usage: {
    rolling: { status: 'ok', percent: 9, resetsAt: null },
    weekly: { status: 'ok', percent: 12, resetsAt: null },
    monthly: { status: 'ok', percent: 6, resetsAt: null },
  },
  usageError: null,
  fetchedAt: new Date().toISOString(),
  usagePending: false,
  credentialSet: true,
  lastFailure: null,
}

/** apply() against a mock client context; returns what got registered. */
function bootClient(module, options = {}) {
  const registrations = {}
  const effects = []
  const ctx = {
    remote: { $mount: async () => () => {} },
    effect: (fn, label) => {
      effects.push(label)
      const dispose = fn()
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: {
      register: (opts, component) => { registrations[opts.name] = { ...opts, component }; return () => {} },
      inject: (_name, factory) => { factory() },
    },
    inject: (_names, callback) => { if (options.layout !== false) callback(ctx) },
    get: name => (name === 'remote.opencodePool' ? options.remote ?? null : null),
  }
  module.apply(ctx)
  return { registrations, effects, ctx }
}

test('bundle executes and apply() registers all three surfaces', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { registrations } = bootClient(module)

  const section = registrations['settings.section']
  assert.ok(section, 'the settings section is registered')
  assert.equal(section.id, 'opencode-go-pool')
  assert.equal(section.order, 41)
  assert.equal(typeof section.component, 'function')
  const labelHtml = renderToString(React.createElement(React.Fragment, null, section.label()))
  // The entry keeps a mark of its own, in the shell's icon language, and that
  // mark is what the stylesheet keys the shell-gear-hiding rule on.
  assert.ok(labelHtml.includes('dsh-ogp-nav-mark'), 'nav label carries the row mark')
  assert.ok(labelHtml.includes('<svg'), 'the mark is a real glyph, like every sibling row')
  assert.ok(labelHtml.includes('nav'), 'nav label carries the localized text')

  // The dashboard cell and the sidebar card share one panel id, which is what
  // makes them a single navigation entry.
  const panel = registrations['main']
  assert.ok(panel, 'the main-slot dashboard is registered')
  assert.equal(panel.key, module.__test.PANEL_ID)
  const foot = registrations['sidebar.footer.action']
  assert.ok(foot, 'the sidebar footer card is registered')
  assert.equal(foot.id, module.__test.PANEL_ID)
})

test('apply() survives a profile with no layout service', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  // A profile without ui-layout never runs the inject callback: the card is
  // simply not registered and nothing else is affected.
  const { registrations } = bootClient(module, { layout: false })
  assert.ok(registrations['settings.section'], 'the settings page is unaffected')
  assert.ok(!registrations['sidebar.footer.action'], 'no dead sidebar card without a layout')
})

test('the settings page renders the loading hint before the first read', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { registrations } = bootClient(module)
  const html = renderToString(React.createElement(registrations['settings.section'].component, {
    t: key => key,
    store: stubStore(null),
  }))
  assert.ok(html.includes('title'), 'renders the page title')
  assert.ok(html.includes('loading'), 'renders the loading hint')
})

test('the page lays the modules out as divided groups each with a small heading', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { registrations } = bootClient(module)
  const html = renderToString(React.createElement(registrations['settings.section'].component, {
    t: key => key,
    store: stubStore({ ...POOL_STATUS, keys: [KEY] }),
  }))

  // Small headings, one per module.
  for (const heading of ['accountsTitle', 'modelsTitle', 'integrationsTitle', 'advancedTitle']) {
    assert.ok(html.includes(heading), `the ${heading} group heading renders`)
  }
  // The hairline separates GROUPS, so models/integrations/advanced carry it and
  // the accounts group (which opens the page) does not.
  assert.equal((html.match(/ogp-groupDivided/g) || []).length, 3, 'three dividers between four modules')
  assert.ok(html.indexOf('accountsTitle') < html.indexOf('modelsTitle'), 'accounts open the page')
  assert.ok(html.indexOf('modelsTitle') < html.indexOf('integrationsTitle'), 'models precede integrations')
  assert.ok(html.indexOf('integrationsTitle') < html.indexOf('advancedTitle'), 'advanced closes the page')

  // Empty pool: the guidance replaces the cards, and no account row renders.
  const empty = renderToString(React.createElement(registrations['settings.section'].component, {
    t: key => key,
    store: stubStore({ ...POOL_STATUS, keys: [] }),
  }))
  assert.ok(empty.includes('noKeysTitle'), 'an empty pool shows the add-account guidance')
  assert.ok(empty.includes('accountAdd'), 'and the add-account action')
})

test('an account card is one slim line with the kebab at its top-left', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { AccountItem } = module.__test

  const html = renderToString(React.createElement(AccountItem, {
    item: KEY,
    t: key => key,
    tick: Date.now(),
    busy: null,
    multi: true,
    data: { ...POOL_STATUS, keys: [KEY] },
    actions: {
      tick: Date.now(), refresh: () => {}, notifyInvalid: () => {}, addAccount: () => {},
      setActive: () => {}, setDisabled: () => {}, clearInvalid: () => {},
      setKey: async () => true, rename: async () => true, remove: async () => true,
    },
  }))

  assert.ok(html.includes('主号'), 'shows the label')
  assert.ok(html.includes('activeBadge'), 'shows the in-use badge')
  assert.ok(html.includes('ogp-accountToggle'), 'the head is the disclosure toggle')
  assert.ok(html.includes('ogp-kebab'), 'the kebab edit control renders')
  assert.ok(html.includes('ogp-iconButton'), 'the kebab is a real button')
  // The kebab is the FIRST child of the head: the "点点点" edit control sits at
  // the card's top-left, as asked.
  assert.ok(html.indexOf('ogp-iconButton') < html.indexOf('ogp-accountName'), 'kebab precedes the name')
  // Slim by default: the compact meters are there, the full windows are not.
  assert.ok(html.includes('ogp-miniMeter'), 'collapsed cards show the compact meters')
  assert.ok(!html.includes('ogp-windowLabel'), 'collapsed cards hide the full windows')
  assert.ok(!html.includes('credentialRef'), 'collapsed cards hide the credential reference')
})

test('a failed account card states the reason and offers a credential fix', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { AccountItem } = module.__test

  const render = item => renderToString(React.createElement(AccountItem, {
    item, t: key => key, tick: Date.now(), busy: null, multi: true,
    data: { ...POOL_STATUS, keys: [item] },
    actions: {
      tick: Date.now(), refresh: () => {}, notifyInvalid: () => {}, addAccount: () => {},
      setActive: () => {}, setDisabled: () => {}, clearInvalid: () => {},
      setKey: async () => true, rename: async () => true, remove: async () => true,
    },
  }))

  const rejected = render({
    ...KEY,
    id: 'acc-b',
    label: '备用2',
    state: 'invalid',
    active: false,
    usage: null,
    usageError: 'http-503',
    usagePending: false,
    credentialSet: true,
  })
  assert.ok(rejected.includes('invalidBadge'), 'shows the invalid badge')
  assert.ok(rejected.includes('httpError'), 'shows the coded usage error')
  assert.ok(rejected.includes('ogp-kebab'), 'the kebab that opens the credential editor renders')

  // A key whose credential is missing reports that once the pass has run — and
  // the missing key is named as a configuration state, not as a failure.
  const unset = render({
    ...KEY, id: 'acc-c', label: '备用3', active: false,
    usage: null, usageError: 'no-api-key', usagePending: false, credentialSet: false,
  })
  assert.ok(unset.includes('apiKeyUnset'), 'an unconfigured key is named as such')
  assert.ok(unset.includes('noApiKey'), 'and its usage error says so')

  // Before the first pass completes NOTHING is claimed about the credential:
  // every key reads as still loading rather than as unconfigured.
  const pending = render({
    ...KEY, id: 'acc-d', label: '备用4', active: false,
    usage: null, usageError: null, usagePending: true, credentialSet: false,
  })
  assert.ok(pending.includes('usagePending'), 'a key with no completed pass reads as loading')
  assert.ok(!pending.includes('apiKeyUnset'), 'and is not prematurely called unconfigured')
})

test('the page title row carries the takeover badge and no refresh controls', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)

  const renderPage = data => renderToString(React.createElement(module.__test.PoolPage, {
    t: key => key,
    store: stubStore(data),
  }))

  // Serving: a green badge on the title row, and nothing else up there.
  const serving = renderPage({ ...POOL_STATUS, keys: [KEY] })
  assert.ok(serving.includes('takeoverBadgeServing'), 'the takeover state is a label')
  assert.ok(serving.includes('ogp-badgeOk'), 'and green once the route is served')
  assert.ok(serving.indexOf('ogp-title') < serving.indexOf('takeoverBadgeServing'),
    'the badge sits after the title')
  assert.ok(!serving.includes('takeoverServing'), 'the old banner copy is gone')
  // The title row no longer offers a refresh or a timestamp of its own.
  const titleRow = serving.slice(serving.indexOf('ogp-header'), serving.indexOf('ogp-group'))
  assert.ok(!titleRow.includes('updatedAt'), 'no timestamp on the title row')
  assert.ok(!titleRow.includes('>refresh<'), 'no refresh action on the title row')
  assert.ok(!titleRow.includes('<svg'), 'no glyph on the title row either')

  // Waiting: amber, and the actionable hint stays because only it explains how
  // to hand the route over.
  const waiting = renderPage({ ...POOL_STATUS, takeover: 'waiting', takeoverHint: 'owned elsewhere', keys: [KEY] })
  assert.ok(waiting.includes('takeoverBadgeWaiting'))
  assert.ok(waiting.includes('ogp-badgeWarn'), 'a non-serving state is amber')
  assert.ok(waiting.includes('takeoverWaitingHint'), 'the handover guidance survives')
  assert.ok(waiting.includes('owned elsewhere'), 'including the host refusal reason')

  // The timestamp moved to the accounts row, next to that row's refresh action.
  const accounts = waiting.slice(waiting.indexOf('accountsTitle'), waiting.indexOf('modelsTitle'))
  assert.ok(accounts.includes('ogp-groupAction'), 'the refresh and timestamp share one row')
  assert.ok(accounts.includes('>refresh<'), 'the accounts refresh is there')
})

test('the takeover badge is green only for the served route', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  const { takeoverBadge } = module.__test
  const tr = key => key

  assert.deepEqual(takeoverBadge('serving', tr), { cls: 'ogp-badge ogp-badgeOk', text: 'takeoverBadgeServing' })
  for (const state of ['own-route', 'waiting', undefined]) {
    assert.equal(takeoverBadge(state, tr).cls, 'ogp-badge ogp-badgeWarn', `${state} is amber`)
  }
})

test('the save bar appears only for unsaved configuration', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { SaveBar } = module.__test

  const bar = overrides => renderToString(React.createElement(SaveBar, {
    t: key => key, visible: false, tone: 'pending', message: '', actions: false,
    saving: false, onSave: () => {}, onDiscard: () => {},
    ...overrides,
  }))

  // Hidden: mounted but inert, so its surface is out of the tab order.
  const hidden = bar({})
  assert.ok(hidden.includes('ogp-saveBarDock'), 'the bar stays mounted')
  assert.ok(!hidden.includes('ogp-saveBarShown'), 'and stays out of view')
  assert.ok(hidden.includes('aria-hidden="true"'))

  // Unsaved: the message and both actions.
  const dirty = bar({ visible: true, tone: 'pending', message: 'unsavedChanges', actions: true })
  assert.ok(dirty.includes('ogp-saveBarShown'), 'the bar slides in')
  assert.ok(dirty.includes('unsavedChanges'), 'it names the pending state')
  assert.ok(dirty.includes('discard'), 'discard is offered')
  assert.ok(dirty.includes('>save<'), 'and save')

  // Invalid: the error tone, and the same two actions (save is refused by the
  // page, which never calls through with a patch).
  const invalid = bar({ visible: true, tone: 'error', message: 'saveInvalid', actions: true })
  assert.ok(invalid.includes('ogp-saveBar-error'))
  assert.ok(invalid.includes('saveInvalid'))

  // Saved: a confirmation with no actions to take.
  const saved = bar({ visible: true, tone: 'success', message: 'saved', actions: false })
  assert.ok(saved.includes('ogp-saveBar-success'))
  assert.ok(!saved.includes('ogp-saveBarActions'), 'the confirmation carries no buttons')
})

test('the staged patch carries only what actually moved', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  const { stagedConfig, readStaged, stagedPatch } = module.__test

  const data = { ...POOL_STATUS, keys: [KEY] }
  const baseline = stagedConfig(data, data.availableModels)
  assert.equal(stagedPatch(baseline, baseline, readStaged(baseline)), null, 'an untouched draft is nothing to save')

  const touched = { ...baseline, preempt: '80' }
  assert.deepEqual(stagedPatch(touched, baseline, readStaged(touched)), { preemptAtPercent: 80 })

  const retried = { ...baseline, retries: '9' }
  assert.deepEqual(stagedPatch(retried, baseline, readStaged(retried)), { transportMaxRetries: 9 })

  const seconds = { ...baseline, request: '42' }
  assert.deepEqual(stagedPatch(seconds, baseline, readStaged(seconds)), { requestTimeoutMs: 42000 })

  const toggled = { ...baseline, showSidebarQuota: true }
  assert.deepEqual(stagedPatch(toggled, baseline, readStaged(toggled)), { showSidebarQuota: true })

  // A model selection is two fields, and 'all' stores an empty list.
  const narrowed = { ...baseline, mode: 'custom', ids: ['deepseek-v4-pro'] }
  assert.deepEqual(stagedPatch(narrowed, baseline, readStaged(narrowed)), {
    modelMode: 'custom', models: ['deepseek-v4-pro'],
  })
  const all = { ...baseline, mode: 'all', ids: ['deepseek-v4-pro'] }
  assert.equal(stagedPatch(all, baseline, readStaged(all)), null, 're-checking "all" is not a change')

  // Several moves ride one patch.
  const many = { ...baseline, preempt: '70', consec: '4', retries: '0' }
  assert.deepEqual(stagedPatch(many, baseline, readStaged(many)), {
    preemptAtPercent: 70, switchAfterConsecutiveFailures: 4, transportMaxRetries: 0,
  })

  // Numeric equality, not string equality: re-typing the same number is not a change.
  const sameValue = { ...baseline, preempt: '100.0' }
  assert.equal(stagedPatch(sameValue, baseline, readStaged(sameValue)), null)
})

test('the models module carries the range switch and the allowlist', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { ModelsGroup } = module.__test

  const data = {
    ...POOL_STATUS,
    modelMode: 'custom',
    availableModels: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true, dynamic: false },
      { id: 'glm-5.3', name: 'GLM-5.3', enabled: false, dynamic: true },
    ],
  }
  const collapsed = renderToString(React.createElement(ModelsGroup, {
    t: key => key, data, busy: null,
    current: stagedFor(module, data).current,
    onSetMode: () => {}, onToggleModel: () => {},
    onFetch: () => {}, fetching: false,
  }))
  assert.ok(collapsed.includes('modelsTitle'), 'the module heading renders')
  assert.ok(collapsed.includes('allModels'), 'the all-models switch renders')
  assert.ok(collapsed.includes('modelFetch'), 'the fetch action renders')
  assert.ok(collapsed.includes('modelCount'), 'the enabled-count badge renders')
  assert.ok(!collapsed.includes('DeepSeek V4 Pro'), 'the allowlist is collapsed by default')
  assert.ok(!collapsed.includes('>save<'), 'the module carries no save button of its own')

  const expandable = renderToString(React.createElement(ModelsGroup, {
    t: key => key, data, busy: null,
    current: stagedFor(module, data).current,
    onSetMode: () => {}, onToggleModel: () => {}, onFetch: () => {}, fetching: false,
  }))
  assert.ok(expandable.includes('modelExpand'), 'an expand affordance is offered')

  // A custom selection with nothing checked is refused by the row itself.
  const empty = stagedFor(module, data)
  const emptied = { ...empty.current, mode: 'custom', ids: [] }
  const emptyHtml = renderToString(React.createElement(ModelsGroup, {
    t: key => key, data, busy: null,
    current: emptied, reading: module.__test.readStaged(emptied),
    onSetMode: () => {}, onToggleModel: () => {}, onFetch: () => {}, fetching: false,
  }))
  assert.ok(emptyHtml.includes('modelNone'), 'an empty custom selection is stated on the row')
})

test('the advanced module exposes the three network settings', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { AdvancedGroup, readStaged, stagedConfig } = module.__test

  const { current } = stagedFor(module, POOL_STATUS)

  // Collapsed by default: the heading and the disclosure only.
  const collapsed = renderToString(React.createElement(AdvancedGroup, {
    t: key => key, data: POOL_STATUS, busy: null, current, reading: readStaged(current),
    onEdit: () => {},
  }))
  assert.ok(collapsed.includes('advancedTitle'), 'the advanced heading renders')
  assert.ok(!collapsed.includes('requestTimeout'), 'the fields stay collapsed')
  assert.ok(!collapsed.includes('>save<'), 'the module carries no save button of its own')

  // The staged reading drives the per-field errors, including for a live draft.
  const bad = { ...current, request: '0.5', retries: '99' }
  const badReading = readStaged(bad)
  assert.equal(badReading.request.ok, false)
  assert.equal(badReading.retries.ok, false)
  assert.equal(module.__test.stagedValid(badReading), false)
  assert.equal(module.__test.stagedValid(readStaged(current)), true)

  // A value taken from the host marks the field as customized.
  const tuned = stagedConfig({ ...POOL_STATUS, requestTimeoutMs: 42000 }, [])
  assert.equal(tuned.request, '42')
})

test('the seconds <-> milliseconds conversion round-trips and bounds', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  const { msToSecondsText, secondsTextToMs } = module.__test

  assert.equal(msToSecondsText(300000), '300')
  assert.equal(msToSecondsText(42000), '42')
  assert.equal(msToSecondsText(1500), '1.5')
  assert.deepEqual(secondsTextToMs('300'), { ok: true, value: 300000 })
  assert.deepEqual(secondsTextToMs('1.5'), { ok: true, value: 1500 })
  assert.deepEqual(secondsTextToMs('0.5'), { ok: false, reason: 'tooSmall' })
  assert.deepEqual(secondsTextToMs('3601'), { ok: false, reason: 'tooLarge' })
  assert.deepEqual(secondsTextToMs('abc'), { ok: false, reason: 'invalid' })
  assert.deepEqual(secondsTextToMs(''), { ok: false, reason: 'invalid' })
})

test('usage windows render used/left, a bar and a reset countdown', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { UsageWindow, barTone, barPercent } = module.__test

  const resetsAt = new Date(Date.now() + (2 * 60 + 13) * 60000 + 10000).toISOString()
  const html = renderToString(React.createElement(UsageWindow, {
    label: 'rolling',
    windowData: { status: 'ok', percent: 9, resetsAt },
    t: key => key,
    tick: Date.now(),
  }))
  assert.ok(html.includes('9%'), 'used percent')
  assert.ok(html.includes('91%'), 'remaining percent')
  assert.ok(html.includes('2h 13m'), 'reset countdown renders')
  assert.ok(html.includes('resets'), 'the reset label renders')

  assert.equal(barPercent({ percent: 250 }), 100, 'bar fill is clamped')
  assert.equal(barPercent(null), 0)
  assert.equal(barTone({ percent: 10 }), 'flat')
  assert.equal(barTone({ percent: 95 }), 'alert')
  assert.equal(barTone({ percent: 100 }), 'warn')
})

test('the sidebar card stays hidden and inert until the flag is on', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { QuotaFooterCard } = module.__test

  const off = renderToString(React.createElement(QuotaFooterCard, {
    t: key => key, store: stubStore({ ...POOL_STATUS, keys: [KEY] }), wide: true, open: () => {},
  }))
  assert.equal(off, '', 'nothing renders while the toggle is off')

  // Unknown state (no status read yet) also renders nothing.
  const unknown = renderToString(React.createElement(QuotaFooterCard, {
    t: key => key, store: stubStore(null), wide: true, open: () => {},
  }))
  assert.equal(unknown, '', 'nothing renders before the flag is known')

  const on = renderToString(React.createElement(QuotaFooterCard, {
    t: key => key,
    store: stubStore({ ...POOL_STATUS, showSidebarQuota: true, keys: [KEY] }),
    wide: true,
    open: () => {},
  }))
  assert.ok(on.includes('ogp-foot'), 'the wide card renders as the shell owns no chrome')
  assert.ok(on.includes('ogp-footBar'), 'the card carries the window bars')
  assert.ok(on.includes('9%'), 'the serving account rolling percent')
  assert.ok(on.includes('12%'), 'the serving account weekly percent')
  assert.ok(on.includes('ogp-glyph'), 'the ring glyph renders')

  const rail = renderToString(React.createElement(QuotaFooterCard, {
    t: key => key,
    store: stubStore({ ...POOL_STATUS, showSidebarQuota: true, keys: [KEY] }),
    wide: false,
    open: () => {},
  }))
  assert.ok(rail.includes('ogp-railButton'), 'the collapsed column gets a 36px rail button')
})

test('the dashboard panel renders every account with its three windows', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { QuotaPanel } = module.__test

  const second = { ...KEY, id: 'acc-b', label: '备用2', active: false, state: 'exhausted' }
  const html = renderToString(React.createElement(QuotaPanel, {
    t: key => key,
    store: stubStore({ ...POOL_STATUS, keys: [KEY, second] }),
    close: () => {},
  }))
  assert.ok(html.includes('panelTitle'), 'the panel header renders')
  assert.ok(html.includes('主号') && html.includes('备用2'), 'every account is listed')
  assert.ok(html.includes('exhaustedBadge'), 'a spent account is flagged')
  assert.ok(html.includes('ogp-windowLabel'), 'the full windows render in the dashboard')
  assert.ok(html.includes('ogp-close'), 'the dashboard keeps its exit')
})

test('a two-account page renders both cards, their states and the strategy rows', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { PoolPage, statusDotClass, stateBadge } = module.__test

  const second = {
    ...KEY, id: 'acc-b', label: '备用2', active: false, state: 'exhausted',
    usage: { ...KEY.usage, rolling: { status: 'exhausted', percent: 100, resetsAt: null } },
  }
  const html = renderToString(React.createElement(PoolPage, {
    t: key => key,
    store: stubStore({ ...POOL_STATUS, preemptAtPercent: 80, switchAfterConsecutiveFailures: 3, keys: [KEY, second] }),
  }))

  assert.ok(html.includes('主号') && html.includes('备用2'), 'both accounts render')
  assert.ok(html.includes('accountModePinned'), 'a pinned account is named in the rotation line')
  assert.ok(html.includes('strategyTitle'), 'the rotation rules live in the accounts module')
  // The strategy inputs carry the live values, not the defaults.
  assert.ok(html.includes('value="80"'), 'the preempt threshold comes from the config')
  assert.ok(html.includes('value="3"'), 'the consecutive-failure threshold comes from the config')
  // Both cards, both kebabs, and the add action.
  assert.equal((html.match(/ogp-kebab/g) || []).length, 2, 'one kebab per account card')
  assert.ok(html.includes('accountAdd'), 'the add-account action renders')

  // Exactly one refresh (the accounts row's), and NO save button at all until
  // something is actually staged — the two inline save buttons the modules used
  // to carry are gone, and the bar contributes nothing while it is idle.
  assert.equal((html.match(/>refresh</g) || []).length, 1, 'one refresh action on the whole page')
  assert.equal((html.match(/>save</g) || []).length, 0, 'no save action while nothing is staged')
  assert.ok(!html.includes('notifyInvalid'), 'the removed inline save path leaves no trace')

  // The verdict helpers read top-down: a problem outranks "serving".
  assert.equal(statusDotClass({ state: 'invalid', active: true }), 'ogp-dot ogp-dotError')
  assert.equal(statusDotClass({ state: 'exhausted', active: true }), 'ogp-dot ogp-dotWarn')
  assert.equal(statusDotClass({ state: 'healthy', active: true }), 'ogp-dot ogp-dotOk')
  assert.equal(statusDotClass({ state: 'healthy', active: false }), 'ogp-dot ogp-dotBlank')
  assert.deepEqual(stateBadge({ state: 'exhausted' }, key => key, true), { cls: 'ogp-badge ogp-badgeWarn', text: 'exhaustedBadge' })
  assert.equal(stateBadge({ state: 'healthy', active: false }, key => key, true), null, 'a standby account draws no badge')
  assert.deepEqual(stateBadge({ state: 'healthy', active: true }, key => key, true), { cls: 'ogp-badge', text: 'activeBadge' })
  assert.equal(stateBadge({ state: 'healthy', active: true }, key => key, false), null, 'a lone account needs no in-use badge')
})

test('the add-account form asks for a name and a key, and gates its confirm', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const { React, renderToString } = harness
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, React)
  const { AddAccountPanel } = module.__test

  const html = renderToString(React.createElement(AddAccountPanel, {
    t: key => key, disabled: false, onSubmit: () => {}, onCancel: () => {},
  }))
  assert.ok(html.includes('accountAdd'), 'the panel is titled')
  assert.ok(html.includes('accountNamePlaceholder'), 'the display name field renders')
  assert.ok(html.includes('accountKeyPlaceholder'), 'the secret field renders')
  assert.ok(html.includes('type="password"'), 'the secret is masked by default')
  assert.ok(html.includes('accountApply'), 'the confirm action renders')
  assert.ok(html.includes('disabled'), 'confirm stays disabled until both fields are filled')

  // A disabled panel blocks the submit path as well.
  const locked = renderToString(React.createElement(AddAccountPanel, {
    t: key => key, disabled: true, onSubmit: () => {}, onCancel: () => {},
  }))
  assert.ok(locked.includes('disabled'))
})

/**
 * The store is plain JavaScript, so its whole lifecycle — the two-phase load
 * that removes the permanent "查询中…", and the reference-counted poll the
 * surfaces hold open — is exercised here for real, with async calls and a live
 * interval.
 *
 * Every store is released through `t.after`: a failed assertion must not leave
 * a poll armed, or the test process would never drain.
 */
test('the store paints from status and fills the numbers from a second pass', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  const { createPoolStore } = module.__test

  // The poll interval is deliberately long here and the usage call is gated, so
  // the two phases are observed deterministically instead of racing a timer.
  let releaseUsage
  const usageGate = new Promise(resolve => { releaseUsage = resolve })
  const calls = []
  const remote = {
    status: async () => {
      calls.push('status')
      return { ok: true, value: { ...POOL_STATUS, usageRefreshMs: 600000, keys: [{ ...KEY, usage: null, usagePending: true }] } }
    },
    usage: async () => {
      calls.push('usage')
      await usageGate
      return { ok: true, value: { fetchedAt: '2026-01-01T00:00:00.000Z', keys: [{ ...KEY }] } }
    },
  }
  const store = createPoolStore(async () => remote)
  let stop = null
  t.after(() => { if (stop !== null) stop(); store.dispose() })
  const seen = []
  store.subscribe(() => seen.push(store.get()))

  stop = store.retain()
  // Before anything lands there is no data at all — which is the moment the
  // page used to sit on forever.
  assert.equal(store.get().data, null)
  await tick()
  // status() alone is enough to paint: the rows exist, the numbers are pending.
  assert.notEqual(store.get().data, null, 'the pool state arrives first')
  assert.equal(store.get().data.keys[0].usagePending, true, 'the numbers are still pending')
  assert.equal(store.get().data.keys[0].usage, null)
  assert.deepEqual(calls, ['status', 'usage'], 'status first, usage started second')

  releaseUsage()
  await tick()
  assert.equal(store.get().data.keys[0].usage.rolling.percent, 9, 'the usage pass fills the rows')
  assert.equal(store.get().data.keys[0].usagePending, false)
  assert.ok(seen.length >= 2, 'every transition notified the surfaces')
  assert.equal(store.get().error, null)
})

test('the retained poll re-reads on the host interval and stops on release', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  const { createPoolStore } = module.__test

  const calls = []
  const store = createPoolStore(async () => ({
    status: async () => {
      calls.push('status')
      return { ok: true, value: { ...POOL_STATUS, usageRefreshMs: 10, keys: [{ ...KEY }] } }
    },
    usage: async () => {
      calls.push('usage')
      return { ok: true, value: { fetchedAt: '2026-01-01T00:00:00.000Z', keys: [{ ...KEY }] } }
    },
  }))
  let stop = null
  t.after(() => { if (stop !== null) stop(); store.dispose() })

  // Two surfaces sharing the poll: releasing one keeps it alive.
  const first = store.retain()
  stop = store.retain()
  await sleep(60)
  assert.ok(calls.length > 2, 'the poll keeps re-reading while a surface is mounted')
  first()
  const stillPolling = calls.length
  await sleep(40)
  assert.ok(calls.length > stillPolling, 'one remaining holder keeps the poll alive')

  const release = stop
  stop = null
  release()
  const after = calls.length
  await sleep(40)
  assert.equal(calls.length, after, 'releasing the last surface stops the poll')
})

test('the store reports a dead remote instead of hanging', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  const { createPoolStore } = module.__test

  // No remote at all: the page must say so, not spin.
  const missing = createPoolStore(async () => null)
  let stopMissing = null
  t.after(() => { if (stopMissing !== null) stopMissing(); missing.dispose() })
  stopMissing = missing.retain()
  await tick()
  assert.match(missing.get().error, /not mounted/)
  assert.equal(missing.get().data, null)
  assert.equal(missing.get().failures, 1)

  // A host that keeps refusing reports the reason rather than a blank page.
  const failing = createPoolStore(async () => ({
    status: async () => { throw new Error('boom') },
  }))
  let stopFailing = null
  t.after(() => { if (stopFailing !== null) stopFailing(); failing.dispose() })
  stopFailing = failing.retain()
  await tick()
  assert.equal(failing.get().failures, 1)
  assert.match(failing.get().error, /boom/)
})

test('a stale Host without the usage endpoint still paints', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  const { createPoolStore } = module.__test

  // The HMR swap lands the client half before the Host half, and the Host may
  // simply not serve `usage` yet: the rows must survive that.
  const calls = []
  const store = createPoolStore(async () => ({
    status: async () => {
      calls.push('status')
      return { ok: true, value: { ...POOL_STATUS, usageRefreshMs: 5, keys: [{ ...KEY, usage: null, usagePending: true }] } }
    },
  }))
  let stop = null
  t.after(() => { if (stop !== null) stop(); store.dispose() })
  stop = store.retain()
  await sleep(30)
  assert.notEqual(store.get().data, null, 'the page still paints from status')
  assert.equal(store.get().data.keys[0].usagePending, true, 'and the numbers simply stay pending')
  assert.equal(store.get().error, null, 'a missing endpoint is not an error')
  assert.ok(calls.length > 0)
})

async function tick() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('mergeUsage folds a usage pass into the status rows by id', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  const { mergeUsage } = module.__test

  const data = { ...POOL_STATUS, keys: [{ ...KEY, usage: null, usagePending: true }] }
  const merged = mergeUsage(data, [{
    ...KEY, usage: KEY.usage, usagePending: false, usageError: null, fetchedAt: '2026-01-01T00:00:00.000Z', credentialSet: true,
  }])
  assert.equal(merged.keys[0].usage.rolling.percent, 9)
  assert.equal(merged.keys[0].usagePending, false)
  assert.equal(merged.keys[0].state, 'healthy', 'pool state is untouched by the usage merge')
  assert.equal(merged.keys[0].active, true)
  // A row with no matching key is ignored rather than appended.
  assert.equal(mergeUsage(data, [{ ...KEY, id: 'ghost' }]).keys.length, 1)
  assert.equal(mergeUsage(null, []), null)
})

test('the bundle exposes no literal secrets anywhere', async () => {
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  assert.ok(!/sk-opencode-[A-Za-z0-9]+/.test(source), 'no literal OpenCode keys in the bundle')
})

test('the save action exists only on the floating bar', async () => {
  // A structural guard rather than a render assertion: the modules' inline save
  // buttons are easy to reintroduce (the model allowlist's lived inside a block
  // that only renders once expanded, so no server render ever saw it), and the
  // rule the page has to keep is that there is exactly ONE save control.
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  const saves = source.match(/t\('save'\)/g) || []
  assert.equal(saves.length, 1, 'exactly one save action in the whole bundle')

  // ...and it is the bar's. Saving is a draft of configuration, never an account
  // operation: accounts commit through their own remote calls.
  const bar = source.slice(source.indexOf('function SaveBar'), source.indexOf('// ------', source.indexOf('function SaveBar')))
  assert.ok(bar.includes("t('save')"), 'the surviving save action belongs to the bar')
  assert.ok(!bar.includes('putKeys') && !bar.includes('putKeySecret'), 'and never carries an account write')
})

test('every Remote descriptor carries strict codecs (client binder requirement)', async (t) => {
  const spec = await loadClientBundle(t)
  const ReactStub = {
    Component: class {},
    Fragment: {},
    createElement: () => ({}),
    useSyncExternalStore: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const module = instantiate(spec, ReactStub)
  const { TYPERT_REMOTE } = module.__test
  assert.equal(TYPERT_REMOTE.package, 'dsh-opencode-go-pool')
  assert.ok(TYPERT_REMOTE.descriptors.length >= 6)
  const methods = TYPERT_REMOTE.descriptors.map(descriptor => descriptor.method)
  assert.ok(methods.includes('status'), 'status is mounted')
  assert.ok(methods.includes('usage'), 'the split usage endpoint is mounted')
  for (const descriptor of TYPERT_REMOTE.descriptors) {
    assert.equal(descriptor.result.mode, 'strict', `${descriptor.method} result must be strict`)
    assert.equal(typeof descriptor.result.schema.parse, 'function')
    assert.equal(typeof descriptor.result.create, 'function', `${descriptor.method} result needs a create() factory`)
    assert.strictEqual(descriptor.result.create(), descriptor.result.schema, `${descriptor.method} result create() returns its schema`)
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${descriptor.method} parameter ${parameter.name} must be strict`)
      assert.equal(typeof parameter.codec.create, 'function', `${descriptor.method} parameter ${parameter.name} needs create()`)
      assert.strictEqual(parameter.codec.create(), parameter.codec.schema, `${descriptor.method} parameter ${parameter.name} create() returns its schema`)
    }
  }
})

test('unwrapRemote handles the typert result envelope', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)
  const { unwrapRemote } = module.__test
  // Success envelope → business value.
  assert.deepEqual(unwrapRemote({ ok: true, value: { keys: [] } }), { keys: [] })
  // Failure envelope → throws with the host-side message.
  assert.throws(() => unwrapRemote({ ok: false, error: { message: 'host refused' } }), /host refused/)
  // Degenerate shapes pass through harmlessly.
  assert.equal(unwrapRemote(undefined), undefined)
  assert.deepEqual(unwrapRemote({ ok: true }), { ok: true })
})

test('the stylesheet is installed once and keys its own tag', async (t) => {
  const harness = await loadReact(t)
  if (!harness) return
  const spec = await loadClientBundle(t)
  const module = instantiate(spec, harness.React)

  const appended = []
  const previousDocument = globalThis.document
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: tag => appended.push(tag) },
  }
  try {
    const { ctx } = bootClient(module)
    assert.equal(appended.length, 1, 'one stylesheet tag is installed')
    assert.equal(appended[0].dataset.pluginCss, module.__test.CSS_ID)
    assert.match(appended[0].textContent, /\.ogp-accountItem\{/)
    // The one foreign selector is the sidebar foot anchor, which cannot be
    // scoped to our own class.
    assert.match(appended[0].textContent, /_footArea.*_footerActions/)
    void ctx
  } finally {
    globalThis.document = previousDocument
  }
})
