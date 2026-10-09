import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

// Packaging contract for a GitHub install.
//
// `dsh plugin add github:<owner>/<repo>` installs the repository as-is: there is
// no build step (the plugin is plain ESM), so whatever is committed IS what
// runs. The one way that install can break silently is a runtime file that
// exists locally but never reaches the repo — a new module missing from git, or
// one missing from the `files` allowlist a registry install honours. Both are
// checked here, because both fail at plugin activation rather than at test time.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function manifest() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
}

/** Every `./x.js` a source file imports, at any depth of the parent path. */
function relativeImports(source) {
  const found = new Set()
  for (const match of source.matchAll(/from\s+'(\.[^']+)'|require\((\.[^')]+)\)/g)) {
    const specifier = match[1] ?? match[2]
    if (specifier !== undefined) found.add(specifier.replace(/^\.\//, ''))
  }
  return [...found]
}

test('the package ships every file it needs, and every shipped file exists', () => {
  const pkg = manifest()
  const shipped = new Set(pkg.files)

  // The three entry points the DSH bundle resolves by path.
  assert.equal(pkg.main, './index.js')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./typert'], './typert.host.js')

  for (const [label, file] of [
    ['main', 'index.js'],
    ['client', 'client.js'],
    ['typert', 'typert.host.js'],
    ['bundle patch', 'cordis.patch.yml'],
  ]) {
    assert.ok(existsSync(join(root, file)), `${label} (${file}) exists in the repo`)
    assert.ok(shipped.has(file), `${label} (${file}) is listed in package.json files`)
  }

  // The bundle patch the manifest points at is shipped under the same path.
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')

  // Everything the host half imports relatively must be shipped, transitively:
  // index.js is the root, and each module it reaches is walked in turn.
  const pending = [pkg.main.replace(/^\.\//, '')]
  const seen = new Set()
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(join(root, file), 'utf8')
    for (const specifier of relativeImports(source)) {
      assert.ok(existsSync(join(root, specifier)), `${file} imports ${specifier}, which exists`)
      assert.ok(shipped.has(specifier), `${file} imports ${specifier}, which must be shipped`)
      if (specifier.endsWith('.js')) pending.push(specifier)
    }
  }
  // A sanity floor: the walk really did reach the pool, the transport budget and
  // the usage gateway rather than stopping at index.js.
  for (const file of ['pool.js', 'transport.js', 'usage.js', 'models.js']) {
    assert.ok(seen.has(file), `${file} is reachable from the entry point and therefore shipped`)
  }
})

test('the package declares the client bundle the way the loader reads it', () => {
  const pkg = manifest()
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0,
    'the client bundle declares the platform modules it loads against')
  // No build step: a git install runs no script, so a `prepare`/`build` here
  // would either be ignored or break the install outright.
  const scripts = pkg.scripts ?? {}
  assert.equal(scripts.prepare, undefined, 'a git install must not need to build anything')
  assert.equal(scripts.build, undefined, 'the plugin is plain ESM with no build step')
})

test('the bundle patch names the plugin exactly as the manifest does', () => {
  const pkg = manifest()
  const patch = readFileSync(join(root, pkg.dsh.bundle.patch.replace(/^\.\//, '')), 'utf8')
  // The loader resolves the bundle row by `name` (the package it installs) and
  // keys the entry by `id` — which is also the settings namespace the card
  // writes through, so the two must agree with what the plugin registers.
  assert.match(patch, new RegExp(`name: ${pkg.name}\\s*$`, 'm'), 'the entry name is the package name')
  assert.match(patch, /id: opencode-go-pool\s*$/m, 'the entry id is the plugin id')
})
