# dsh-auto-mode
<img width="360" height="100" alt="8d7851c5-4a64-4903-9c1b-68d3fadffb3e" src="https://github.com/user-attachments/assets/f6d0d639-f10f-4d42-8995-fa4643e69f63" />
<img width="360" height="100" alt="50959136-c076-4447-a4d0-05c255efd26d" src="https://github.com/user-attachments/assets/69139524-1737-4996-a1ee-1cf24ff18c54" />


**Auto Mode** for DeepSeek Harness: when enabled, every
approval prompt is auto-accepted — operations that require approval
(workspace-escape file writes, wider shell commands, sandbox escalations) run
immediately without asking you.

## Usage

- `/auto` — toggle Auto Mode for all sessions. The switch is durable
  (`auto-mode` settings namespace) and survives restarts.
- The model is told the current mode through its runtime context
  (`auto-mode:state`) and every switch is narrated into the session
  transcript.
- Config default: `dsh-auto-mode.enabled` (default `false`).

## How it works

The plugin registers the first `approval/request` waterfall listener on the
host plane. When Auto Mode is on it claims every request with
`allowed-once` — before the web UI answerer (registered later in the tree)
can forward it to the browser. When off it delegates via `next()` and the
normal approval flow applies.

The profile keeps this bundle **first** in `dsh.profile.bundles` so the row
precedes the UI answerer row; without that ordering the browser prompt would
claim requests first.

## Safety

Auto Mode grants every request, including destructive ones. The runtime
context warns the model to use extra care with irreversible or costly
operations. Toggle it off with `/auto` at any time.

## Known limitations

- **Hot-reload breaks auto-grant**: this plugin must register its approval
  listener before the web UI answerer. A clean boot guarantees that (the
  profile keeps this bundle first). `dev_reload_package` re-registers the
  listener late, so after hot-reloading this plugin you must restart the web
  service for auto-grant to work again.
- **Narration sentence suppressed by router-family plugins**: the
  `auto-mode:state` runtime-context entry is cleared by plugins that wipe
  `contexts` on `system-prompt/assemble` (dsh-mode-boost and the
  router-standard preset do this by design). The model still learns every
  switch from the injected "Auto Mode is now ON/OFF (changed by the user)."
  transcript message, which no plugin clears.
