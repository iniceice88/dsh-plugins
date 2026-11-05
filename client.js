/**
 * Browser half of `dsh-firefly`.
 *
 * One client module carries the plugin's three browser concerns, all of which
 * read the same two feature switches:
 *
 * 1. **Desktop alerts** — subscribes to the Host's `/api/firefly.events`
 *    Server-Sent Events route and raises a Windows toast while the window is
 *    minimized, hidden, or simply not focused. Clicking a toast asks the Host
 *    to restore and foreground the Electron window.
 * 2. **Composer history** — Up/Down inside the message editor walks the user
 *    messages already sent in this Session, newest first, and refills the draft
 *    through the official `inputActions.setDraft` seat.
 * 3. **Feature switches** — the two rows in Settings → General that write the
 *    Host's `/api/firefly.settings` route, so either feature can be turned off
 *    without disabling the whole plugin (a second notification or history
 *    plugin would otherwise stack on top of this one).
 *
 * Everything is registered from `apply` through `ctx.effect` / `ctx.slots.inject`
 * so unloading the plugin removes the stream, the heartbeat, the slot entries
 * and the listeners.
 */
window.__ModuleLoader__.load({
  id: 'dsh-firefly',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TAG = '[firefly]'
    /** Dictionary namespace this plugin owns. */
    const NS = 'firefly'

    /* ------------------------------------------------------------------ */
    /* routes and slots                                                    */
    /* ------------------------------------------------------------------ */

    const EVENTS_ROUTE = 'api/firefly.events'
    const FOCUS_ROUTE = 'api/firefly.focus'
    const SETTINGS_ROUTE = 'api/firefly.settings'
    /** The Host pings every 25s; a silent stream this long is treated as dead. */
    const STREAM_IDLE_TIMEOUT_MS = 70000
    /** Re-reading the switches on every focus event is unnecessary; collapse the burst. */
    const SETTINGS_REFRESH_MS = 2000

    const HISTORY_SLOT = 'conversation.input.left'
    const HISTORY_ENTRY = 'firefly-history'
    const CARD_SELECTOR = '[data-composer-card]'
    const EDITOR_SELECTOR = '[data-lexical-editor="true"]'
    const HISTORY_KINDS = { user: true, steering: true }
    /** Set true to show the `↑` button in the composer tool row (mouse entry point + mount probe). */
    const SHOW_HINT_BUTTON = false

    /* ------------------------------------------------------------------ */
    /* dictionaries                                                        */
    /* ------------------------------------------------------------------ */

    const DICTS = {
      en: {
        doneTitle: 'Task finished',
        doneBody: 'The Harness task finished. Click to return.',
        approvalTitle: 'Approval needed',
        approvalBody: 'An action is waiting for your approval. Click to return.',
        approvalTool: 'Waiting for approval: ',
        questionTitle: 'Answer needed',
        questionBody: 'A question is waiting for your answer. Click to return.',
        questionHeader: 'Waiting for your answer: ',
        clickBack: 'Click to return.',
        alertsTitle: 'Task alerts',
        alertsDescription:
          'Show a Windows notification when a task finishes or waits for you, and taskbar progress while it runs.',
        historyTitle: 'Composer history',
        historyDescription:
          'Walk through the messages you already sent in this session with Up/Down in the composer.',
        saveFailed: 'Firefly could not save this setting. Please try again.',
      },
      zh: {
        doneTitle: '任务已完成',
        doneBody: 'Harness 中的任务已经结束，点击返回应用。',
        approvalTitle: '需要你的确认',
        approvalBody: '有操作等待你批准，点击返回应用。',
        approvalTool: '等待你批准：',
        questionTitle: '需要你的回答',
        questionBody: '有一个问题等待你回答，点击返回应用。',
        questionHeader: '等待你回答：',
        clickBack: '点击返回应用。',
        alertsTitle: '任务提醒',
        alertsDescription: '任务结束或需要你确认时弹出 Windows 通知；任务运行期间在任务栏显示进度。',
        historyTitle: '输入历史',
        historyDescription: '在输入框内用 ↑/↓ 浏览本会话里你已经发送过的消息。',
        saveFailed: 'Firefly 没能保存这项设置，请重试。',
      },
    }

    /* ------------------------------------------------------------------ */
    /* diagnostics                                                         */
    /* ------------------------------------------------------------------ */

    const state = {
      version: '1.0.0',
      features: { alerts: true, history: true },
      alerts: {
        received: 0,
        lastKind: null,
        errors: [],
      },
      history: {
        mounted: false,
        props: null,
        history: 0,
        phase: null,
        lastKey: null,
        lastResult: null,
        errors: [],
      },
      settings: {
        loaded: false,
        saving: false,
        lastSavedAt: null,
        errors: [],
      },
    }
    try {
      window.__firefly = state
    } catch (error) {
      /* no window: nothing to expose */
    }

    /* ------------------------------------------------------------------ */
    /* feature switches                                                    */
    /* ------------------------------------------------------------------ */

    /** Immutable snapshot handed to React; replaced only when a switch changes. */
    let snapshot = { alerts: true, history: true, loaded: false }
    const listeners = new Set()

    /** Merge booleans into the snapshot and tell the rows about it. */
    function publish(patch) {
      const next = {
        alerts: typeof patch.alerts === 'boolean' ? patch.alerts : snapshot.alerts,
        history: typeof patch.history === 'boolean' ? patch.history : snapshot.history,
        loaded: typeof patch.loaded === 'boolean' ? patch.loaded : snapshot.loaded,
      }
      if (next.alerts === snapshot.alerts && next.history === snapshot.history && next.loaded === snapshot.loaded) {
        return
      }
      snapshot = next
      state.features = { alerts: next.alerts, history: next.history }
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          state.settings.errors.push(String(error))
        }
      }
    }

    /** Read one switch; an unloaded store keeps both features on. */
    const featureOn = (key) => snapshot[key] !== false

    /** Copy the boolean switches out of an untrusted object. */
    function pickFeatures(source) {
      const picked = {}
      if (source === null || typeof source !== 'object') return picked
      for (const key of ['alerts', 'history']) {
        if (typeof source[key] === 'boolean') picked[key] = source[key]
      }
      return picked
    }

    /** Apply a reply body; returns whether any switch was present. */
    function acceptFeatures(source) {
      const picked = pickFeatures(source)
      if (Object.keys(picked).length === 0) return false
      publish(picked)
      return true
    }

    /** Resolve the shell-owned request carrier, falling back to plain fetch. */
    function resolveFetch() {
      const transport = globalThis.__DSH_TRANSPORT__
      if (transport !== undefined && transport !== null && typeof transport.fetch === 'function') {
        return transport.fetch.bind(transport)
      }
      return (input, init) => fetch(input, init)
    }

    function sleep(ms, signal) {
      return new Promise((resolve) => {
        const timer = setTimeout(finish, ms)
        function finish() {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          resolve()
        }
        if (signal.aborted) {
          finish()
          return
        }
        signal.addEventListener('abort', finish, { once: true })
      })
    }

    /**
     * Read both switches from the Host.
     *
     * At startup the browser bundle can arrive before the Host row has
     * registered its routes, so the first read retries a few times instead of
     * leaving one window with stale switches.
     */
    async function loadFeatures(signal, attempts = 1) {
      let lastError = null
      for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
        if (signal?.aborted === true) return
        try {
          const response = await resolveFetch()(SETTINGS_ROUTE, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal,
          })
          if (!response.ok) throw new Error(`${TAG} settings route answered ${response.status}`)
          const body = await response.json()
          if (!acceptFeatures(body)) throw new Error(`${TAG} settings route answered without switches`)
          state.settings.loaded = true
          publish({ loaded: true })
          return
        } catch (error) {
          if (signal?.aborted === true) return
          lastError = error
          if (attempt + 1 < attempts) await sleep(700 * (attempt + 1), signal)
        }
      }
      if (lastError !== null && signal?.aborted !== true) state.settings.errors.push(String(lastError))
    }

    /** Write one switch back to the Host; the Host answers with the effective pair. */
    async function saveFeature(key, value) {
      state.settings.saving = true
      try {
        const response = await resolveFetch()(SETTINGS_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ [key]: value }),
        })
        if (!response.ok) throw new Error(`${TAG} settings route answered ${response.status}`)
        const body = await response.json()
        acceptFeatures(body)
        state.settings.lastSavedAt = Date.now()
        return true
      } finally {
        state.settings.saving = false
      }
    }

    /* ================================================================== */
    /* feature: composer history                                           */
    /* ================================================================== */

    function note(result, extra) {
      state.history.lastResult = result
      try {
        console.debug(TAG, result, extra === undefined ? '' : extra)
      } catch (error) {
        /* console may be unavailable */
      }
    }

    /** Message text of one Chat node's content blocks (images and files contribute nothing). */
    function textOfContent(content) {
      if (!Array.isArray(content)) return ''
      let text = ''
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          text += block.text
        }
      }
      return text.trim() === '' ? '' : text
    }

    /** Sent user messages in transcript order, de-duplicated against the neighbour. */
    function collectHistory(order, nodes) {
      if (!Array.isArray(order) || nodes === undefined || nodes === null) return []
      if (typeof nodes.get !== 'function') return []
      const history = []
      for (const key of order) {
        const node = nodes.get(key)
        if (node === undefined || node === null || HISTORY_KINDS[node.kind] !== true) continue
        const data = node.data
        if (data === undefined || data === null) continue
        const text = textOfContent(data.content)
        if (text === '') continue
        if (history.length === 0 || history[history.length - 1] !== text) history.push(text)
      }
      history.reverse()
      return history
    }

    function elementOf(node) {
      if (node === null || node === undefined) return null
      if (node.nodeType === 1) return node
      return node.parentElement === undefined || node.parentElement === null ? null : node.parentElement
    }

    /** The composer card around an event target, or null outside the composer. */
    function findCard(target) {
      const element = elementOf(target)
      if (element === null || typeof element.closest !== 'function') return null
      return element.closest(CARD_SELECTOR)
    }

    /** Any *visible* popup rendered into the composer card owns Up/Down while it is open. */
    function popupOpen(card) {
      const overlay = card.querySelector('[data-composer-overlay]') || card.querySelector('[class*="overlayAnchor"]')
      if (overlay === null) return false
      const child = overlay.firstElementChild
      if (child === null) return false
      const rect = child.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    /** Whether any real block element sits beside `el` in that direction (skips <br> and hidden nodes). */
    function hasBlockBeside(el, direction) {
      let node = direction < 0 ? el.previousElementSibling : el.nextElementSibling
      while (node !== null) {
        const tag = node.tagName
        if (tag !== 'BR' && tag !== 'STYLE' && tag !== 'SCRIPT') {
          let display = ''
          try {
            display = window.getComputedStyle(node).display
          } catch (error) {
            display = ''
          }
          if (display !== 'none') return true
        }
        node = direction < 0 ? node.previousElementSibling : node.nextElementSibling
      }
      return false
    }

    /**
     * How many hard line breaks sit between `from` and `to` inside one block.
     * Shift+Enter inserts a Lexical line break (`<br>`) instead of a new block,
     * so a block can hold several visual lines.
     */
    function breaksBetween(fromNode, fromOffset, toNode, toOffset) {
      try {
        const range = document.createRange()
        range.setStart(fromNode, fromOffset)
        range.setEnd(toNode, toOffset)
        return range.cloneContents().querySelectorAll('br').length
      } catch (error) {
        return 0
      }
    }

    /**
     * Which edge of the draft the caret sits on: a block is one paragraph
     * (Enter never reaches the draft), and `<br>`s split it into lines
     * (Shift+Enter). Soft wraps inside one line are still not distinguished.
     */
    function caretEdge(root, node, offset) {
      let el = elementOf(node)
      while (el !== null && el !== root) {
        if (el.parentElement === root) {
          const lastChild = el.childNodes.length
          const before = typeof offset === 'number' ? breaksBetween(el, 0, node, offset) : 0
          const after = typeof offset === 'number' ? breaksBetween(node, offset, el, lastChild) : 0
          return {
            first: !hasBlockBeside(el, -1) && before === 0,
            last: !hasBlockBeside(el, 1) && after === 0,
          }
        }
        el = el.parentElement
      }
      return { first: true, last: true }
    }

    function focusEditor(card) {
      const root = card.querySelector(EDITOR_SELECTOR)
      if (root === null || typeof root.focus !== 'function') return
      try {
        root.focus({ preventScroll: true })
      } catch (error) {
        try {
          root.focus()
        } catch (inner) {
          /* focus is best effort */
        }
      }
    }

    /**
     * Props seat wrapper: the hook seats come from the session provide bundle,
     * so an absent seat must not change the inner component's hook order.
     */
    function HistoryArrows(props) {
      const useChat = props.useChat
      const useInput = props.useInput
      const inputActions = props.inputActions
      state.history.mounted = true
      state.history.props = {
        useChat: typeof useChat === 'function',
        useInput: typeof useInput === 'function',
        inputActions: inputActions !== undefined && inputActions !== null,
        setDraft: inputActions !== undefined && inputActions !== null && typeof inputActions.setDraft === 'function',
      }
      const ready =
        state.history.props.useChat === true &&
        state.history.props.useInput === true &&
        state.history.props.setDraft === true
      if (!ready) {
        note('inert:missing-props', state.history.props)
        return null
      }
      return h(HistoryArrowsView, props)
    }

    function HistoryArrowsView(props) {
      const useChat = props.useChat
      const useInput = props.useInput
      const inputActions = props.inputActions
      const order = useChat((value) => value.order)
      const nodes = useChat((value) => value.nodes)
      const draft = useInput((value) => value.draft)
      const phase = useInput((value) => value.phase)
      const history = React.useMemo(() => collectHistory(order, nodes), [order, nodes])
      const cursor = React.useRef({ index: -1, base: '' })
      const live = React.useRef({ history: [], draft: '' })
      live.current.history = history
      live.current.draft = typeof draft === 'string' ? draft : ''
      state.history.history = history.length
      state.history.phase = phase

      const recall = React.useCallback(
        (direction, card, fromMouse) => {
          if (card === null) return 'skip:no-card'
          const list = live.current.history
          if (list.length === 0) return 'skip:no-history'
          const value = live.current.draft
          const cursorState = cursor.current
          if (cursorState.index >= 0 && value !== list[cursorState.index]) {
            cursorState.index = -1
            cursorState.base = value
          }

          if (direction < 0) {
            if (cursorState.index < 0) {
              if (fromMouse !== true) {
                const root = card.querySelector(EDITOR_SELECTOR)
                const selection = window.getSelection()
                if (root === null || selection === null || selection.rangeCount === 0 || selection.isCollapsed !== true)
                  return 'skip:no-caret'
                const anchor = selection.anchorNode
                if (anchor === null || !root.contains(anchor)) return 'skip:caret-outside'
                if (!caretEdge(root, anchor, selection.anchorOffset).first) return 'skip:not-first-line'
              }
              cursorState.base = value
            }
            const next = Math.min(cursorState.index + 1, list.length - 1)
            if (next === cursorState.index) return 'keep:oldest'
            cursorState.index = next
            focusEditor(card)
            inputActions.setDraft(list[next])
            return 'recall'
          }

          if (cursorState.index < 0) {
            return 'skip:idle'
          }
          if (cursorState.index === 0) {
            cursorState.index = -1
            focusEditor(card)
            inputActions.setDraft(cursorState.base)
            return 'restore'
          }
          cursorState.index -= 1
          focusEditor(card)
          inputActions.setDraft(list[cursorState.index])
          return 'forward'
        },
        [inputActions],
      )

      const recallRef = React.useRef(recall)
      recallRef.current = recall

      React.useEffect(() => {
        const onKeyDown = (event) => {
          try {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            state.history.lastKey = event.key
            if (!featureOn('history')) {
              note('skip:feature-off')
              return
            }
            if (event.defaultPrevented) {
              note('skip:defaultPrevented')
              return
            }
            if (event.isComposing || event.keyCode === 229) {
              note('skip:composing')
              return
            }
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
              note('skip:modifier')
              return
            }
            const card = findCard(event.target)
            if (card === null) {
              note('skip:no-card')
              return
            }
            if (popupOpen(card)) {
              note('skip:popup')
              return
            }
            const result = recallRef.current(event.key === 'ArrowUp' ? -1 : 1, card)
            note(result, { key: event.key, history: live.current.history.length })
            if (result === 'recall' || result === 'forward' || result === 'restore') {
              event.preventDefault()
              event.stopPropagation()
            }
          } catch (error) {
            state.history.errors.push(String(error && error.stack ? error.stack : error))
            note('error', String(error))
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [])

      const onClick = React.useCallback((event) => {
        try {
          event.preventDefault()
          note('click', recallRef.current(-1, findCard(event.currentTarget), true))
        } catch (error) {
          state.history.errors.push(String(error && error.stack ? error.stack : error))
        }
      }, [])

      if (SHOW_HINT_BUTTON !== true) return null

      return h(
        'button',
        {
          type: 'button',
          onClick,
          title: '↑/↓ 浏览本会话已发送的消息',
          'aria-label': 'Input history',
          'data-input-history-arrows': true,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '22px',
            height: '22px',
            padding: '0',
            margin: '0',
            border: 'none',
            borderRadius: '6px',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary, inherit)',
            font: 'inherit',
            fontSize: '13px',
            lineHeight: '1',
            cursor: 'pointer',
            opacity: '0.75',
          },
        },
        '↑',
      )
    }

    /* ================================================================== */
    /* feature: settings rows                                              */
    /* ================================================================== */

    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '24px',
      padding: '16px 0',
      borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      color: 'var(--dsw-alias-label-primary)',
    }
    const TITLE_STYLE = { fontSize: '14px', lineHeight: '20px' }
    const DESCRIPTION_STYLE = {
      marginTop: '4px',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const ERROR_STYLE = {
      marginTop: '4px',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-state-error-primary)',
    }

    /**
     * The host's switch control, rebuilt locally: Primitive packages are not a
     * stable dependency for a plain-JS plugin, so only `--dsw-alias-*` tokens
     * are shared. `role="switch"` + `aria-checked` keeps it accessible.
     */
    function Switch(props) {
      const checked = props.checked === true
      const disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': props.label,
          disabled,
          onClick: () => props.onChange(!checked),
          style: {
            position: 'relative',
            flex: '0 0 auto',
            width: '36px',
            height: '20px',
            padding: '0',
            margin: '0',
            border: 'none',
            borderRadius: '10px',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? '0.6' : '1',
            background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
            transition: 'background 120ms ease',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute',
            top: '2px',
            left: checked ? '18px' : '2px',
            width: '16px',
            height: '16px',
            borderRadius: '8px',
            background: '#ffffff',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
            transition: 'left 120ms ease',
          },
        }),
      )
    }

    return {
      inject: ['locale', 'slots'],
      apply(ctx) {
        const controller = new AbortController()

        /** Pick the dictionary from the active locale; a missing locale means English. */
        const t = (key) => {
          let active = ''
          try {
            const value = ctx.locale.getLocale()
            active = String(value?.active ?? value?.id ?? value?.language ?? value?.locale ?? '')
          } catch (error) {
            active = ''
          }
          const dict = active.toLowerCase().startsWith('zh') ? DICTS.zh : DICTS.en
          const text = dict[key]
          return typeof text === 'string' ? text : key
        }

        /* ---------------- settings rows ---------------- */

        /** One feature switch row; `field` decides which switch it owns. */
        function makeRow(field) {
          const title = field === 'history' ? 'historyTitle' : 'alertsTitle'
          const description = field === 'history' ? 'historyDescription' : 'alertsDescription'
          return function FeatureRow() {
            const [busy, setBusy] = React.useState(false)
            const [failed, setFailed] = React.useState(false)
            const [features, setFeatures] = React.useState(snapshot)

            React.useEffect(() => {
              const listener = () => setFeatures(snapshot)
              listeners.add(listener)
              return () => {
                listeners.delete(listener)
              }
            }, [])

            const checked = features[field] !== false
            return h(
              'div',
              { style: ROW_STYLE, 'data-firefly-row': field },
              h(
                'div',
                null,
                h('div', { style: TITLE_STYLE }, t(title)),
                h('div', { style: DESCRIPTION_STYLE }, t(description)),
                failed ? h('div', { role: 'alert', style: ERROR_STYLE }, t('saveFailed')) : null,
              ),
              h(Switch, {
                checked,
                disabled: busy,
                label: t(title),
                onChange: (next) => {
                  setFailed(false)
                  setBusy(true)
                  publish({ [field]: next })
                  saveFeature(field, next)
                    .catch(() => {
                      publish({ [field]: !next })
                      setFailed(true)
                    })
                    .finally(() => setBusy(false))
                },
              }),
            )
          }
        }

        const AlertsRow = makeRow('alerts')
        const HistoryRow = makeRow('history')

        ctx.effect(
          () =>
            ctx.slots.inject('settings.general.item', () =>
              ctx.slots.register(
                {
                  name: 'settings.general.item',
                  id: 'firefly-alerts',
                  order: 60,
                  locale: NS,
                },
                AlertsRow,
              ),
            ),
          'firefly: alerts switch',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('settings.general.item', () =>
              ctx.slots.register(
                {
                  name: 'settings.general.item',
                  id: 'firefly-history',
                  order: 61,
                  locale: NS,
                },
                HistoryRow,
              ),
            ),
          'firefly: history switch',
        )

        /* ---------------- settings sync ---------------- */

        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, DICTS)
          } catch (error) {
            /* a hot-reloaded instance may already own the namespace */
            state.settings.errors.push(String(error))
            return undefined
          }
        }, 'firefly: dictionaries')

        ctx.effect(() => {
          let last = 0
          const refresh = () => {
            const now = Date.now()
            if (now - last < SETTINGS_REFRESH_MS) return
            last = now
            void loadFeatures(controller.signal)
          }
          window.addEventListener('focus', refresh)
          document.addEventListener('visibilitychange', refresh)
          void loadFeatures(controller.signal, 5)
          return () => {
            window.removeEventListener('focus', refresh)
            document.removeEventListener('visibilitychange', refresh)
          }
        }, 'firefly: settings sync')

        /* ---------------- desktop alerts ---------------- */

        /** Notify only when the user cannot see the window. */
        const shouldNotify = () => {
          if (typeof document === 'undefined') return false
          if (document.hidden === true) return true
          try {
            return document.hasFocus() === false
          } catch (error) {
            return true
          }
        }

        const describe = (frame) => {
          if (frame.kind === 'done') {
            return { title: t('doneTitle'), body: t('doneBody') }
          }
          if (frame.kind === 'approval') {
            const tool = typeof frame.tool === 'string' ? frame.tool.trim() : ''
            return {
              title: t('approvalTitle'),
              body: tool === '' ? t('approvalBody') : `${t('approvalTool')}${tool} · ${t('clickBack')}`,
            }
          }
          if (frame.kind === 'question') {
            const header = typeof frame.header === 'string' ? frame.header.trim() : ''
            return {
              title: t('questionTitle'),
              body: header === '' ? t('questionBody') : `${t('questionHeader')}${header} · ${t('clickBack')}`,
            }
          }
          return null
        }

        const focusApp = async () => {
          try {
            window.focus()
          } catch (error) {
            /* focus best effort */
          }
          try {
            await resolveFetch()(FOCUS_ROUTE, { method: 'POST' })
          } catch (error) {
            /* the Host may already be gone */
          }
        }

        const notify = (frame) => {
          if (!featureOn('alerts')) return
          if (typeof Notification === 'undefined') return
          if (Notification.permission === 'denied') return
          if (!shouldNotify()) return
          const spec = describe(frame)
          if (spec === null) return
          if (Notification.permission === 'default') {
            try {
              Notification.requestPermission()
            } catch (error) {
              /* a prompt without a gesture is simply ignored */
            }
          }
          let notification
          try {
            notification = new Notification(spec.title, {
              body: spec.body,
              tag: `firefly-${frame.kind}`,
              silent: false,
            })
          } catch (error) {
            state.alerts.errors.push(String(error))
            return
          }
          notification.onclick = () => {
            try {
              notification.close()
            } catch (error) {
              /* already dismissed */
            }
            void focusApp()
          }
        }

        const receive = (text) => {
          let frame
          try {
            frame = JSON.parse(text)
          } catch (error) {
            return
          }
          if (frame === null || typeof frame !== 'object') return
          if (frame.kind === 'settings') {
            acceptFeatures(frame)
            return
          }
          state.alerts.received += 1
          state.alerts.lastKind = String(frame.kind ?? '')
          notify(frame)
        }

        const followWithFetch = async (doFetch, signal) => {
          let attempt = 0
          while (!signal.aborted) {
            try {
              const response = await doFetch(EVENTS_ROUTE, {
                method: 'GET',
                headers: { accept: 'text/event-stream' },
                signal,
              })
              if (!response.ok || response.body === null) {
                throw new Error(`${TAG} events route answered ${response.status}`)
              }
              attempt = 0
              const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
              let idleTimer = null
              const stopIdle = () => {
                if (idleTimer !== null) {
                  clearTimeout(idleTimer)
                  idleTimer = null
                }
              }
              const touchIdle = () => {
                stopIdle()
                idleTimer = setTimeout(() => {
                  idleTimer = null
                  state.alerts.errors.push('stream idle timeout; reconnecting')
                  reader.cancel().catch(() => {})
                }, STREAM_IDLE_TIMEOUT_MS)
              }
              let buffer = ''
              touchIdle()
              try {
                for (;;) {
                  const { done, value } = await reader.read()
                  if (done) break
                  touchIdle()
                  buffer += value
                  let boundary = buffer.indexOf('\n\n')
                  while (boundary !== -1) {
                    const block = buffer.slice(0, boundary)
                    buffer = buffer.slice(boundary + 2)
                    const data = block
                      .split('\n')
                      .filter((line) => line.startsWith('data:'))
                      .map((line) => line.slice(5).trimStart())
                      .join('\n')
                    if (data !== '') receive(data)
                    boundary = buffer.indexOf('\n\n')
                  }
                }
              } finally {
                stopIdle()
              }
            } catch (error) {
              if (signal.aborted) return
              state.alerts.errors.push(String(error))
            }
            if (signal.aborted) return
            const delay = Math.min(15000, 800 * 2 ** Math.min(attempt, 4))
            attempt += 1
            await sleep(delay, signal)
          }
        }

        const followWithEventSource = (signal) => {
          let source
          try {
            source = new EventSource(EVENTS_ROUTE)
          } catch (error) {
            state.alerts.errors.push(String(error))
            return
          }
          source.addEventListener('message', (event) => {
            receive(event.data)
          })
          signal.addEventListener(
            'abort',
            () => {
              try {
                source.close()
              } catch (error) {
                /* already closed */
              }
            },
            { once: true },
          )
        }

        const follow = async (signal) => {
          const transport = globalThis.__DSH_TRANSPORT__
          if (transport !== undefined && transport !== null && typeof transport.fetch === 'function') {
            await followWithFetch(transport.fetch.bind(transport), signal)
            return
          }
          followWithEventSource(signal)
        }

        ctx.effect(() => {
          void follow(controller.signal)
          return () => controller.abort()
        }, 'firefly: event stream')

        /* ---------------- composer history ---------------- */

        ctx.effect(
          () =>
            ctx.slots.inject(HISTORY_SLOT, () =>
              ctx.slots.register(
                {
                  name: HISTORY_SLOT,
                  id: HISTORY_ENTRY,
                  order: 100,
                },
                HistoryArrows,
              ),
            ),
          'firefly: composer history',
        )
      },
    }
  },
})
