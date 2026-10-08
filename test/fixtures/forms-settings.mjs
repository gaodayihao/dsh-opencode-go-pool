/**
 * A faithful double of DSH 0.2.1's `SettingsForms` write path.
 *
 * The real service (`@deepseek-ai/dsh-settings`) is the config-editor backed
 * forms service: `update(ns, patch)`/`replace(ns, section)` merge the patch into
 * the plugin's own Config, the Loader applies the volatile fields **in place**
 * (`updateVolatile`) without remounting the plugin, and announces
 * `loader/volatile-update` on the plugin's context.
 *
 * This double keeps those two observable facts — in-place volatile writes and
 * the announcement — and records every write so a test can assert the
 * namespace and payload. It deliberately does not model the profile-file
 * persistence, revision fencing, or schema validation the real service adds
 * around the same write; `test/integration.test.mjs` still exercises the real
 * `LlmRuntime` registry on top of it.
 */

/**
 * The write symbol schemastery's `.volatile()` refs expose: the same
 * `Symbol.for("cosmokit.volatile.write")` cosmokit's `updateVolatile` uses.
 */
export const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Build the double.
 * @param root - the cordis context the plugin fiber lives under, used to
 *   announce `loader/volatile-update` exactly where the Loader emits it.
 * @returns `{ service, state, bind }`: the service to provide as `settings`,
 *   the recorded writes plus the bound Config, and the binder to call with
 *   `fiber.config` once the plugin has started.
 */
export function createFormsSettings(root) {
  const state = { config: null, writes: [] }

  const apply = (ns, patch) => {
    if (state.config === null) throw new Error('forms-settings: bind(fiber.config) was never called')
    state.writes.push({ ns, patch: structuredClone(patch) })
    for (const [key, value] of Object.entries(patch)) {
      const field = state.config[key]
      if (field !== null && typeof field === 'object' && typeof field[VOLATILE_WRITE] === 'function') {
        // The Loader's _commitVolatile path: the ref keeps its identity and the
        // running plugin reads the new value without a remount.
        field[VOLATILE_WRITE](value)
      } else {
        state.config[key] = value
      }
    }
    root.emit('loader/volatile-update', [Object.keys(patch)])
  }

  return {
    state,
    bind: (config) => { state.config = config },
    service: {
      /** The real service describes the volatile form of each active entry. */
      describe: () => [],
      async update(ns, patch) { apply(ns, patch) },
      async replace(ns, section) { apply(ns, section) },
    },
  }
}