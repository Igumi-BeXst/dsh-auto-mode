/**
 * dsh-auto-mode: Claude Code-style Auto Mode for DeepSeek Harness.
 *
 * When Auto Mode is ON, every `approval/request` resolves to `allowed-once`
 * before any interactive answerer (the web UI) sees it, so operations that
 * require approval run immediately without prompting the user. When OFF the
 * listener delegates through `next()` and the normal approval flow applies.
 *
 * Safety invariant: sandbox escalations to `danger-full-access` are
 * auto-granted ONLY when the underlying command is not a dangerous delete.
 * The listener resolves the real command text of the escalating tool call
 * (via the request's callId against the session log) and matches it against
 * the Windows destructive-delete patterns — recursive deletes
 * (`Remove-Item -Recurse`, `rm -rf`, `rd /s`), wildcard deletes, drive-root
 * deletes, trailing-backslash-quote path bugs (the classic "delete a link
 * and wipe the target/root" shape), and junction/symlink-targeted deletes.
 * Dangerous commands fall through to the interactive answerer so the user is
 * always asked; every other danger-full-access escalation is auto-granted.
 * The model is told the same rule in the runtime-context sentence.
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
const ON_SENTENCE = 'Auto Mode is ON: approval prompts are auto-accepted in this session — every operation that requires approval runs immediately without asking you. Do not ask for confirmation before acting; proceed directly. Exception: sandbox escalations to danger-full-access are auto-granted EXCEPT for destructive deletes — recursive deletes, wildcard deletes, drive-root deletes, or any delete touching a junction/symlink — which always require your explicit approval and show an approval prompt. For any other operation that needs full access, request the escalation normally (with justification) and it will be auto-approved. Use extra care with destructive, irreversible, or costly operations.'

/**
 * Reason prefix the sandbox escalation path generates for requests targeting
 * `danger-full-access` (see `approveEscalation` in dsh-sandbox). The approval
 * waterfall matches on it so Auto Mode can judge this upgrade.
 */
const DANGER_ESCALATION_REASON = 'escalate sandbox to danger-full-access'

/**
 * Destructive-delete patterns: the Windows accident shapes where deleting one
 * path can expand into deleting a link target or a whole root. Each pattern
 * is anchored to the delete verb and stays within one statement
 * (`[^;\n|]*`) so a compound command does not cross-contaminate statements.
 * Matched commands are NEVER auto-granted.
 */
const DANGEROUS_DELETE_PATTERNS = [
  // Recursive deletes: Remove-Item -Recurse / rm -r / rm -rf / rd /s / rmdir /s / del /s
  /\bRemove-Item\b[^;\n|]*-Recurse\b/i,
  /\brm\s+-r(?:f)?\b/i,
  /\b(?:rd|rmdir)\s+\/s\b/i,
  /\bdel\s+\/s\b/i,
  // Wildcard deletes: may expand to the whole matched set
  /\b(?:Remove-Item|rm|del|rd|rmdir|erase)\b[^;\n|]*[*?]/i,
  // Drive-root deletes: `Remove-Item C:\` / `rd /s C:\` etc.
  /\b(?:Remove-Item|rm|rd|rmdir)\b[^;\n|]*\b[A-Za-z]:\\{1,2}\s*["']?\s*(?:$|;|\||-)/im,
  // Trailing-backslash + quote: `"C:\path\"` — the backslash escapes the quote
  // (bash/cmd), so the path boundary is lost and the delete can hit the root.
  /["'][A-Za-z]:[^"'\r\n]*\\["']/,
  // Junction/symlink/reparse-point-targeted deletes
  /\b(?:Remove-Item|rm|rd|rmdir|del|erase)\b[^;\n|]*(?:junction|symlink|reparse\s*point|symbolic\s*link)/i,
]

/** True when the command text matches a destructive-delete pattern. */
function isDangerousDelete(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return false
  const text = command.replace(/\r\n/g, '\n')
  return DANGEROUS_DELETE_PATTERNS.some((re) => re.test(text))
}

/**
 * Resolve the REAL command text of the escalating tool call. The approval
 * request carries only `callId` + the model-written `reason`; the actual
 * command lives in the session log's `assistant/message` tool-call block
 * whose id matches the callId. Returns `undefined` when the call cannot be
 * resolved (the caller then fails closed to the interactive answerer).
 */
function toolCommandOf(req) {
  try {
    const events = req.agent.session.events
    if (!Array.isArray(events)) return undefined
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (!event || event.type !== 'assistant/message') continue
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!block || block.type !== 'tool-call') continue
        if (String(block.id) !== String(req.callId)) continue
        const args = typeof block.arguments === 'string'
          ? JSON.parse(block.arguments)
          : block.arguments
        if (args && typeof args.command === 'string') return args.command
      }
    }
  } catch {
    // Unresolvable call: treated as unknown below (fail closed to the user).
  }
  return undefined
}

export function apply(ctx, config) {
  const scope = ctx.settings.register(NS, z.object({
    enabled: z.boolean().default(false),
  }), {
    base: { enabled: config.enabled },
  })
  const isEnabled = () => scope.get().enabled

  // True when the request is a sandbox escalation to danger-full-access
  // (reason generated by approveEscalation in dsh-sandbox).
  const isDangerEscalation = (req) => typeof req.reason === 'string' && req.reason.startsWith(DANGER_ESCALATION_REASON)

  // Runs before the web UI answerer (registered later in the tree), so an
  // enabled session's requests never reach the browser prompt — EXCEPT
  // dangerous deletes and unresolvable danger-full-access escalations, which
  // fall through so the user is asked even while Auto Mode is on.
  ctx.on('approval/request', (req, next) => {
    if (!isEnabled()) return next()
    if (!isDangerEscalation(req)) return 'allowed-once'
    const command = toolCommandOf(req)
    if (command !== undefined && !isDangerousDelete(command)) return 'allowed-once'
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
