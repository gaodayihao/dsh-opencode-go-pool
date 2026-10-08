import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createSettingsScope } from '../index.js'
import { TYPERT } from '../typert.host.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoDir = dirname(testDir)
const pluginEntry = pathToFileURL(join(repoDir, 'index.js')).href

test('plugin entry imports against the installed DSH 0.2.1 surface', () => {
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--input-type=module',
    '--eval', `await import(${JSON.stringify(pluginEntry)})`,
  ], { encoding: 'utf8', cwd: repoDir })
  assert.equal(result.status, 0, result.stderr)
})

test('adapts the DSH 0.2.1 SettingsForms seam as an update/replace scope', async () => {
  const writes = []
  const listeners = []
  const ctx = {
    settings: {
      update: async (ns, patch) => { writes.push({ action: 'update', ns, patch }) },
      replace: async (ns, section) => { writes.push({ action: 'replace', ns, section }) },
    },
    fiber: {
      entry: { options: { id: 'opencode-go-pool' } },
      config: { route: 'opencode-go', keys: [] },
    },
    on: (event, listener) => {
      listeners.push({ event, listener })
      return () => { listeners.splice(listeners.indexOf(listeners.at(-1)), 1) }
    },
  }

  const scope = createSettingsScope(ctx, { keys: [] }, ctx.fiber.entry)
  assert.equal(scope.get().route, 'opencode-go')
  assert.ok(Array.isArray(scope.get().keys))

  await scope.update({ preemptAtPercent: 80 })
  assert.deepEqual(writes[0], {
    action: 'update',
    ns: 'opencode-go-pool',
    patch: { preemptAtPercent: 80 },
  })
  await scope.replace({ route: 'opencode-go-pool', keys: [] })
  assert.equal(writes[1].action, 'replace')
  assert.equal(writes[1].ns, 'opencode-go-pool')

  // The live watch binds the loader's in-place volatile announcement.
  let fired = 0
  const dispose = scope.watch(() => { fired += 1 })
  assert.equal(listeners[0].event, 'loader/volatile-update')
  listeners[0].listener([['keys']])
  assert.equal(fired, 1)
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('names the plugin entry id as the write namespace, falling back to the plugin name', async () => {
  const writes = []
  const ctx = {
    settings: {
      update: async (ns, patch) => { writes.push({ ns, patch }) },
      replace: async () => {},
    },
    fiber: { config: { route: 'opencode-go', keys: [] } },
  }
  const scope = createSettingsScope(ctx, { keys: [] })
  await scope.update({ preemptAtPercent: 80 })
  assert.equal(writes[0].ns, 'opencode-go-pool')
})

test('falls back to the DSH 0.1.7 configEditor seam as a restart-scoped scope', async () => {
  const entry = { id: 'opencode-go-pool' }
  const current = { route: 'opencode-go', keys: [] }
  const edits = []
  const editor = {
    edit: async (target, change) => {
      assert.equal(target, entry)
      edits.push(change(current, {}))
    },
  }
  const ctx = { settings: {}, fiber: { config: current } }

  const scope = createSettingsScope(ctx, current, entry, editor)
  assert.equal(scope.get().route, 'opencode-go')
  assert.ok(Array.isArray(scope.get().keys))
  const dispose = scope.watch(() => { throw new Error('unexpected live watch on DSH 0.1.7') })
  assert.equal(typeof dispose, 'function')
  dispose()
  await scope.update({ preemptAtPercent: 80 })
  assert.deepEqual(edits, [{ route: 'opencode-go', keys: [], preemptAtPercent: 80 }])
  await assert.rejects(
    () => scope.update({
      keys: [
        { id: 'a', label: 'A', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
        { id: 'b', label: 'B', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
      ],
    }),
    /duplicate apiKeyEnv/,
  )
  assert.equal(edits.length, 1, 'a refused write never reaches configEditor.edit')
  await scope.replace({ route: 'opencode-go-pool', keys: [] })
  assert.equal(edits.length, 2)
  assert.deepEqual(edits[1], { route: 'opencode-go-pool', keys: [] })
})

test('declares the standard DSH bundle patch', async () => {
  const manifest = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const patch = await readFile(join(repoDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: opencode-go-pool/)
  assert.match(patch, /name: dsh-opencode-go-pool/)
})

test('ships every invocation codec as strict with a create() factory', () => {
  assert.ok(TYPERT.invocations.length > 0)
  for (const invocation of TYPERT.invocations) {
    const codecs = [
      ...invocation.parameters.map(parameter => parameter.codec),
      invocation.result,
    ]
    for (const [index, codec] of codecs.entries()) {
      const where = `${invocation.id} codec #${index}`
      assert.equal(codec.mode, 'strict', `${where}: mode`)
      assert.equal(typeof codec.typeSymbol, 'string', `${where}: typeSymbol`)
      assert.ok(codec.schema, `${where}: schema`)
      assert.equal(typeof codec.create, 'function', `${where}: create`)
      assert.strictEqual(codec.create(), codec.schema, `${where}: create() returns the schema`)
    }
  }
})