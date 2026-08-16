/* dsh-auto-mode client half: the Auto Mode status chip on its own line
 * ABOVE the composer card ('conversation.input.dock'), horizontally aligned
 * with the composer card (centered band, not the page left edge). Loaded
 * through the client module loader (CJS wrapper); the loader id MUST equal
 * the package name.
 *
 * State source: the host route /api/auto-mode/state (the settings bridge
 * only exposes whitelisted namespaces to configuration clients, so the chip
 * polls its own endpoint, wallet-style). Poll + window focus refresh, plus a
 * best-effort settings-invalidation push as an instant trigger. */
window.__ModuleLoader__.load({
  id: 'dsh-auto-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var css = [
      '.dsam_row{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,780px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));margin:2px auto 0;padding:0 var(--dsh-composer-dock-inset,8px);flex:none;display:flex;justify-content:flex-start}',
      '.dsam_chip{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.6));height:22px;color:var(--dsw-alias-label-tertiary,#6b7280);white-space:nowrap;border-radius:999px;align-items:center;display:inline-flex;gap:5px;padding:0 8px;font-size:12px;line-height:1;cursor:pointer;box-sizing:border-box;min-width:calc(8ch + 28px);justify-content:center;font-family:inherit}',
      '.dsam_chip::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}',
      '.dsam_on{color:var(--dsw-alias-state-success-primary,#22c55e);border-color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dsam_off{color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.dsam_unknown{opacity:.55}'
    ].join('')

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin="dsh-auto-mode"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-auto-mode'
      tag.textContent = css
      document.head.appendChild(tag)
    }

    var POLL_MS = 3000

    function AutoModeChip(props) {
      props = props || {}
      var remote = props.remote
      var onEvent = props.onEvent
      var [state, setState] = React.useState('unknown')
      React.useEffect(function () {
        var alive = true
        function load() {
          fetch('/api/auto-mode/state').then(function (resp) {
            if (!resp.ok) throw new Error(String(resp.status))
            return resp.json()
          }).then(function (json) {
            if (!alive) return
            setState(json && json.ok === true && json.enabled === true ? 'on' : 'off')
          }).catch(function () {
            if (alive) setState('unknown')
          })
        }
        load()
        var disposers = []
        if (remote !== undefined) {
          disposers.push(remote.$on('settings/document-updated', function (ns) {
            if (ns === 'auto-mode') load()
          }))
        }
        if (onEvent !== undefined) {
          disposers.push(onEvent('connection/reset', function () { load() }))
        }
        var timer = setInterval(load, POLL_MS)
        var onFocus = function () { load() }
        window.addEventListener('focus', onFocus)
        return function () {
          alive = false
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          for (var i = 0; i < disposers.length; i++) disposers[i]()
        }
      }, [remote, onEvent])

      var label = state === 'on' ? 'Auto ON' : state === 'off' ? 'Auto OFF' : 'Auto …'
      var cls = 'dsam_chip' + (state === 'on' ? ' dsam_on' : state === 'off' ? ' dsam_off' : ' dsam_unknown')
      function toggle(event) {
        if (event !== undefined) event.preventDefault()
        fetch('/api/auto-mode/toggle', { method: 'POST' }).then(function (resp) {
          if (!resp.ok) throw new Error(String(resp.status))
          return resp.json()
        }).then(function (json) {
          setState(json && json.ok === true && json.enabled === true ? 'on' : 'off')
        }).catch(function () {
          setState('unknown')
        })
      }
      return React.createElement('div', { className: 'dsam_row' },
        React.createElement('button', {
          type: 'button',
          className: cls,
          onClick: toggle,
          title: state === 'on'
            ? 'Auto Mode 已开启：授权请求自动放行（点击关闭）'
            : 'Auto Mode 已关闭：授权请求需要确认（点击开启）',
          'aria-label': label
        }, label))
    }

    var inject = ['slots', 'remote']

    function apply(ctx) {
      ctx.inject(['slots', 'conversation'], function (scope) {
        scope.effect(function () {
          var injected = function () {
            return {
              remote: ctx.remote,
              onEvent: ctx.on.bind(ctx)
            }
          }
          return scope.slots.register({
            name: 'conversation.input.dock',
            id: 'auto-mode',
            order: -20,
            inject: injected
          }, AutoModeChip)
        }, 'dsh-auto-mode: chip registration')
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
