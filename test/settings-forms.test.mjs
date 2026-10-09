import assert from 'node:assert/strict'
import test from 'node:test'

// The REAL DSH 0.2.1 settings service (`@deepseek-ai/dsh-settings`, the
// config-editor backed SettingsForms) over a stub config editor. This pins the
// two facts the plugin's settings integration depends on:
//
//   1. the plugin Config is a valid forms schema whose *volatile* fields are
//      exactly the card-editable ones — `route` must stay ordinary, because
//      switching it remounts the plugin;
//   2. a card write (`ctx.settings.update(entryId, patch, revision)`) merges
//      into the entry's raw config through the real service, refuses
//      non-volatile paths, and fences on the revision `describe()` returned.
//
// The profile-file persistence and the Loader's in-place volatile application
// sit behind the config editor and are covered by the contract double in
// test/fixtures/forms-settings.mjs plus the Loader's own tests.

const NS = 'opencode-go-pool'

/** FiberState.ACTIVE: a running entry is what the service describes. */
const ACTIVE = 2

async function loadSettings(t) {
  let Context, Settings, Config
  try {
    ;({ Context } = await import('@deepseek-ai/cordis'))
    ;({ default: Settings } = await import('@deepseek-ai/dsh-settings'))
    ;({ Config } = await import('../index.js'))
  } catch {
    t.skip('harness peer deps not installed — link the DSH node_modules to run the settings tests')
    return null
  }
  return { Context, Settings, Config }
}

/**
 * Boot the real settings service over one fake loader entry for the plugin.
 * @returns the service, the recorded `configEditor.edit` results, the raw
 *   config the entry stands at, and the cordis root.
 */
async function bootSettings(Context, Settings, Config) {
  const raw = { route: 'opencode-go', keys: [], preemptAtPercent: 100, modelMode: 'all', models: [] }
  const live = Config(raw)
  const edits = []
  const entry = {
    options: { id: NS, name: 'dsh-opencode-go-pool', config: raw },
    fiber: { uid: 42, state: ACTIVE, runtime: { Config }, config: live, ctx: new Context() },
  }
  const root = new Context()
  root.provide('loader', { await: async () => {} })
  root.provide('profileContext', { home: '/tmp', dir: '/tmp', patchPath: '/tmp/dsh-opencode-go-pool.patch.yml' })
  root.provide('configEditor', {
    documentPath: '/tmp/dsh-opencode-go-pool.patch.yml',
    configuration: () => [{ entry, inherited: structuredClone(raw), override: {} }],
    entries: () => [entry],
    // The real editor persists the returned config; the next describe() sees it
    // and advances the revision, which is what fences a stale write.
    edit: async (_target, change) => {
      const next = change(structuredClone(raw), structuredClone(raw))
      edits.push(next)
      entry.options.config = next
    },
  })
  await root.plugin(Settings)
  return { root, settings: root.get('settings'), edits, raw, entry, live }
}

test('the plugin Config is a valid 0.2.1 settings form of exactly the editable fields', async (t) => {
  const harness = await loadSettings(t)
  if (harness === null) return
  const { Context, Settings, Config } = harness
  const { root, settings } = await bootSettings(Context, Settings, Config)

  const descriptors = settings.describe()
  const ours = descriptors.find(descriptor => descriptor.ns === NS)
  assert.ok(ours, 'the plugin entry is listed as a settings form')
  assert.equal(ours.autoGenerate, true)
  assert.equal(ours.applies, 'live')

  const dict = ours.schema.refs[ours.schema.uid].dict
  const fields = Object.keys(dict).sort()
  assert.deepEqual(fields, [
    'keys',
    'modelMode',
    'models',
    'preemptAtPercent',
    'requestTimeoutMs',
    'showSidebarQuota',
    'streamIdleTimeoutMs',
    'switchAfterConsecutiveFailures',
    'transportMaxRetries',
  ], 'exactly the card-editable fields are volatile')
  assert.deepEqual(ours.value, {
    keys: [],
    preemptAtPercent: 100,
    switchAfterConsecutiveFailures: 0,
    modelMode: 'all',
    models: [],
    requestTimeoutMs: 300000,
    streamIdleTimeoutMs: 300000,
    transportMaxRetries: 5,
    showSidebarQuota: false,
  })
  await root.fiber.dispose()
})

test('a card write merges through the real service with revision fencing', async (t) => {
  const harness = await loadSettings(t)
  if (harness === null) return
  const { Context, Settings, Config } = harness
  const { root, settings, edits } = await bootSettings(Context, Settings, Config)
  const descriptor = settings.describe().find(row => row.ns === NS)

  await settings.update(NS, {
    keys: [{ id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' }],
    preemptAtPercent: 80,
  }, descriptor.revision)
  assert.equal(edits.length, 1)
  assert.deepEqual(edits[0], {
    route: 'opencode-go',
    keys: [{ id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' }],
    preemptAtPercent: 80,
    modelMode: 'all',
    models: [],
  }, 'ordinary fields are preserved and only the patch moves')

  // A non-volatile field is refused by the real service, not merely ignored.
  await assert.rejects(
    () => settings.update(NS, { route: 'opencode-go-pool' }),
    /"route" is not volatile/,
  )

  // Revision fencing: the descriptor moved on after the write.
  await assert.rejects(
    () => settings.update(NS, { preemptAtPercent: 90 }, descriptor.revision),
    err => err && err.code === 'SETTINGS_CONFLICT',
  )
  assert.equal(edits.length, 1, 'a refused write never reaches the config editor')
  await root.fiber.dispose()
})

test('the plugin scope adapter drives the real service end to end', async (t) => {
  const harness = await loadSettings(t)
  if (harness === null) return
  const { Context, Settings, Config } = harness
  const { root, settings, edits, entry, live } = await bootSettings(Context, Settings, Config)
  const { createSettingsScope } = await import('../index.js')

  // The plugin's own constructor context shape: a fiber entry plus live config.
  const pluginCtx = {
    settings,
    fiber: { entry, config: live },
    on: () => () => {},
  }
  const scope = createSettingsScope(pluginCtx, live, entry)
  assert.equal(scope.get().route, 'opencode-go', 'the live config refs are read')

  await scope.update({ keys: [{ id: 'acc-b', label: '备用', apiKeyEnv: 'OPENCODE_GO_KEY_B' }] })
  assert.equal(edits.length, 1)
  assert.deepEqual(edits[0].keys, [{ id: 'acc-b', label: '备用', apiKeyEnv: 'OPENCODE_GO_KEY_B' }])

  await scope.replace({ keys: [], preemptAtPercent: 60, switchAfterConsecutiveFailures: 2, modelMode: 'custom', models: ['deepseek-v4-flash'] })
  assert.equal(edits.length, 2)
  assert.equal(edits[1].preemptAtPercent, 60)
  await root.fiber.dispose()
})