/**
 * dsh-auto-mode: Claude Code-style Auto Mode for DeepSeek Harness.
 *
 * When Auto Mode is ON, every `approval/request` resolves to `allowed-once`
 * before any interactive answerer (the web UI) sees it, so operations that
 * require approval run immediately without prompting the user. When OFF the
 * listener delegates through `next()` and the normal approval flow applies.
 *
 * Safety invariant: sandbox escalations to `danger-full-access` from SHELL
 * tools are auto-granted only when the underlying command is not a dangerous
 * delete. The listener resolves the real command text of the escalating
 * tool call (via the request's callId against the session log) and matches
 * it against the Windows destructive-delete patterns — recursive deletes
 * (`Remove-Item -Recurse`, `rm -rf`, `rd /s`), wildcard deletes, drive-root
 * deletes, trailing-backslash-quote path bugs (the classic "delete a link
 * and wipe the target/root" shape), and junction/symlink-targeted deletes.
 * Dangerous commands fall through to the interactive answerer so the user is
 * always asked; every other danger-full-access escalation — including all
 * filesystem-tool escalations, which take structured path arguments — is
 * auto-granted. The model is told the same rule in the runtime-context
 * sentence.
 *
 * The listener is registered on the ROOT context with `global` + `prepend`
 * (see the comment at the registration site): dsh-session >= 0.1.5 dispatches
 * this event scoped to the requesting agent, and a listener carrying the
 * plugin's own bundle scope is filtered out of that dispatch entirely. The
 * state is one global switch in the `auto-mode` settings namespace (default
 * from the plugin config). The composer status chip is both the indicator and
 * the control: it polls the state endpoint and POSTs to the toggle endpoint —
 * no chat message is ever produced. The model learns the mode from a
 * runtime-context sentence (`auto-mode:state`).
 */

import z from '@deepseek-ai/schemastery'

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

/**
 * Settings namespace carrying the durable Auto Mode switch. A plain string:
 * dsh-settings >= 0.1.5 removed the `settingsNamespace()` brand helper and
 * takes the lowercase kebab-case namespace directly (the older helper only
 * validated the same pattern and returned the string unchanged, so this
 * spelling works on both).
 */
const NS = 'auto-mode'

/** Model-facing statement shown while Auto Mode is on. */
const ON_SENTENCE = 'Auto Mode is ON: approval prompts are auto-accepted in this session — every operation that requires approval runs immediately without asking you. Do not ask for confirmation before acting; proceed directly. Exception: danger-full-access escalations of shell commands (pwsh/bash) are auto-granted EXCEPT for destructive deletes — recursive deletes, wildcard deletes, drive-root deletes, or any delete touching a junction/symlink — which always require your explicit approval and show an approval prompt. Filesystem tools never prompt under Auto Mode. For any other operation that needs full access, request the escalation normally (with justification) and it will be auto-approved. Use extra care with destructive, irreversible, or costly operations.'

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
 * Read a session's event log across dsh-session API generations:
 * `snapshotEvents()` (>= 0.1.5) or the older `events` array property. Returns
 * `undefined` when neither yields an array.
 */
function sessionEvents(session) {
  if (session === undefined || session === null) return undefined
  if (typeof session.snapshotEvents === 'function') {
    const snapshot = session.snapshotEvents()
    return Array.isArray(snapshot) ? snapshot : undefined
  }
  const events = session.events
  return Array.isArray(events) ? events : undefined
}

/** Parse a tool call's `arguments` (JSON string or object) into its command text. */
function commandFromArguments(argumentsValue) {
  const args = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue
  return args && typeof args.command === 'string' ? args.command : undefined
}

/**
 * Resolve the REAL command text of the escalating tool call. The approval
 * request carries only `callId` + the model-written `reason`; the actual
 * command lives in the session log, either on the dedicated `tool/call` event
 * (`callId` + `arguments`) or inside an `assistant/message` tool-call block
 * whose id matches. Returns `undefined` when the call cannot be resolved (the
 * caller then fails closed to the interactive answerer).
 */
function toolCommandOf(req) {
  try {
    const events = sessionEvents(req.agent?.session)
    if (events === undefined) return undefined
    const callId = String(req.callId)
    // Pass 1: the dedicated tool/call event carries arguments directly.
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (!event || event.type !== 'tool/call') continue
      const data = event.data
      if (!data || String(data.callId) !== callId) continue
      const command = commandFromArguments(data.arguments)
      if (command !== undefined) return command
    }
    // Pass 2: fall back to the tool-call block inside assistant/message.
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (!event || event.type !== 'assistant/message') continue
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!block || block.type !== 'tool-call') continue
        if (String(block.id) !== callId) continue
        const command = commandFromArguments(block.arguments)
        if (command !== undefined) return command
      }
    }
  } catch {
    // Unresolvable call: treated as unknown below (fail closed to the user).
  }
  return undefined
}

/**
 * True for shell tools whose escalation request carries a command string:
 * `pwsh` and `bash` (including persistent variants). Only these need the
 * dangerous-delete guard — filesystem tools take structured arguments.
 */
function isShellTool(req) {
  const name = typeof req.toolName === 'string' ? req.toolName : ''
  return name === 'pwsh' || name === 'bash' || name.endsWith(':pwsh') || name.endsWith(':bash')
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

  // Runs before the web UI answerer, so an enabled session's requests never
  // reach the browser prompt — EXCEPT dangerous shell deletes, which fall
  // through so the user is asked even while Auto Mode is on.
  //
  // Registered on the ROOT context: dsh-session >= 0.1.5 dispatches this event
  // through `scopeTarget(req.agent, req.agent)`, and Cordis's dispatch filter
  // admits a listener only when its context carries no scope or is scoped to
  // that agent (or an ancestor). The plugin's own context carries a bundle
  // scope, which is neither, so a listener registered there never runs — the
  // request would go straight to the browser answerer. The root context is
  // scope-less, which the filter admits unconditionally; `global` states the
  // same intent explicitly, and `prepend` sorts this listener ahead of the
  // answerer, whose pending answer would otherwise stop the waterfall first.
  const approvalTarget = typeof ctx.root?.on === 'function' ? ctx.root : ctx
  approvalTarget.on('approval/request', (req, next) => {
    if (!isEnabled()) return next()
    if (!isDangerEscalation(req)) return 'allowed-once'
    // The dangerous-delete guard applies to shell tools only (pwsh/bash):
    // their command text can carry the Windows accident shapes (recursive,
    // wildcard, drive-root, trailing-backslash-quote, junction). Filesystem
    // tools (edit/write/read/fs-*) take structured path arguments, not command
    // strings, so they are always auto-granted when Auto Mode is on.
    if (!isShellTool(req)) return 'allowed-once'
    const command = toolCommandOf(req)
    if (command !== undefined && !isDangerousDelete(command)) return 'allowed-once'
    return next()
  }, { global: true, prepend: true })

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
