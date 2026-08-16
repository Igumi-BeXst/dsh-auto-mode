/**
 * dsh-auto-mode: Claude Code-style Auto Mode for DeepSeek Harness.
 *
 * When Auto Mode is ON, every `approval/request` resolves to `allowed-once`
 * before any interactive answerer (the web UI) sees it, so operations that
 * require approval run immediately without prompting the user. When OFF the
 * listener delegates through `next()` and the normal approval flow applies.
 *
 * The listener is registered on the host plane, which receives every agent's
 * scope-filtered dispatch; the state is one global switch in the `auto-mode`
 * settings namespace (default from the plugin config). The composer status
 * chip is both the indicator and the control: it polls the state endpoint
 * and POSTs to the toggle endpoint — no chat message is ever produced.
 * The model learns the mode from a runtime-context sentence
 * (`auto-mode:state`).
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'auto-mode'

/**
 * The approval service (for the `approval/request` waterfall), the prompt
 * assembler (runtime-context sentence), the settings provider (durable
 * switch), and the web server (status + toggle endpoints).
 */
export const inject = ['approval', 'systemPrompt', 'settings', 'webServer']

/** Plugin config: the Auto Mode default for every session. */
export const Config = z.object({
  enabled: z.boolean().default(false),
})

/** Settings namespace carrying the durable Auto Mode switch. */
const NS = settingsNamespace('auto-mode')

/** Model-facing statement shown while Auto Mode is on. */
const ON_SENTENCE = 'Auto Mode is ON: approval prompts are auto-accepted in this session — every operation that requires approval runs immediately without asking you. Do not ask for confirmation before acting; proceed directly. Use extra care with destructive, irreversible, or costly operations.'

export function apply(ctx, config) {
  const scope = ctx.settings.register(NS, z.object({
    enabled: z.boolean().default(false),
  }), {
    base: { enabled: config.enabled },
  })
  const isEnabled = () => scope.get().enabled

  // Runs before the web UI answerer (registered later in the tree), so an
  // enabled session's requests never reach the browser prompt.
  ctx.on('approval/request', (req, next) => {
    if (isEnabled()) return 'allowed-once'
    return next()
  })

  ctx.systemPrompt.context({
    name: 'auto-mode:state',
    order: 116,
    text: () => (isEnabled() ? ON_SENTENCE : ''),
  })

  // Browser endpoints: the composer chip polls /api/auto-mode/state and
  // toggles via POST /api/auto-mode/toggle. The settings bridge only exposes
  // whitelisted namespaces to configuration clients, so these dedicated
  // routes are the exposure path for the chip.
  ctx.effect(() => {
    const json = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: '/api/auto-mode/state',
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        json(res, 200, { ok: true, enabled: isEnabled() })
      },
    })
    const disposeToggle = ctx.webServer.register({
      kind: 'exact',
      path: '/api/auto-mode/toggle',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        scope.update({ enabled: !isEnabled() }).then(() => {
          json(res, 200, { ok: true, enabled: isEnabled() })
        }, (error) => {
          json(res, 500, { ok: false, error: String(error && error.message || error) })
        })
      },
    })
    return () => {
      disposeState()
      disposeToggle()
    }
  }, 'dsh-auto-mode: status and toggle routes')
}
