/**
 * Host half of `dsh-firefly`.
 *
 * Firefly is the single install that carries two desktop conveniences, each of
 * which the browser can switch off on its own:
 *
 * 1. **Alerts** — an indeterminate taskbar progress bar while any agent runs,
 *    and a Server-Sent Events frame on `/api/firefly.events` that the browser
 *    half turns into a Windows toast when the window is not in front of the
 *    user.
 * 2. **Composer history** — implemented entirely by the browser half; this half
 *    only carries the shared on/off state so both halves agree on it.
 *
 * The on/off state is stored in `<DSH_HOME>/firefly/settings.json`. The two
 * switches in Settings → General write it through `/api/firefly.settings`, and
 * the browser half learns about a change from that response or from a
 * `settings` frame on the event stream.
 *
 * The Host process is plain Node (it has no `BrowserWindow`), so the taskbar
 * button is addressed by the Electron main process's window handle, found
 * through this process's parent id.
 *
 * `approval/request` and `user-questions/request` are waterfalls: the first
 * listener that returns a value owns the request and the rest never run. The
 * controller UI registers before any profile plugin, so both observers are
 * prepended and always delegate with `next()`.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'firefly'
export const inject = ['connection']

/** Absolute routes the Host registers; the browser addresses them document-relative. */
const EVENTS_ROUTE = '/api/firefly.events'
const FOCUS_ROUTE = '/api/firefly.focus'
const SETTINGS_ROUTE = '/api/firefly.settings'

const HELPER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'helper', 'taskbar.ps1')

/** Taskbar states understood by the helper script. */
const TASKBAR_INDETERMINATE = 'INDETERMINATE'
const TASKBAR_NONE = 'NONE'
const TASKBAR_FOCUS = 'FOCUS'

/** Values a row config may still override; every one of them has a safe default. */
const DEFAULTS = {
  /** Master switch for toasts, taskbar progress and focus requests. */
  alerts: true,
  /** Master switch for the composer Up/Down history in the browser half. */
  history: true,
  /** Notify when every agent goes idle. */
  notifyOnDone: true,
  /** Notify when a tool call waits for approval. */
  notifyOnApproval: true,
  /** Notify when the agent asks the user a question. */
  notifyOnQuestion: true,
  /** Show the indeterminate taskbar progress while any agent runs. */
  taskbarProgress: true,
  /** Wait this long for a follow-up run before announcing a finish. */
  doneDelayMs: 600,
}

/** Fields the Settings switches own; they are the only ones persisted to disk. */
const FEATURE_KEYS = ['alerts', 'history']

/** `<DSH_HOME>/firefly/settings.json`, or a best-effort home fallback. */
function settingsFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'firefly', 'settings.json')
}

/** Pick the boolean feature fields out of an untrusted object. */
function pickFeatures(source) {
  const picked = {}
  if (source === null || typeof source !== 'object') return picked
  for (const key of FEATURE_KEYS) {
    const value = source[key]
    if (typeof value === 'boolean') picked[key] = value
  }
  return picked
}

/** JSON response helper shared by the routes. */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const encoder = new TextEncoder()
  /** SSE writers for connected pages. */
  const subscribers = new Set()
  /** Cleanup for every open SSE response, so a plugin unload closes the pages' streams. */
  const streamStops = new Set()
  /** Ids of agents that are currently running. */
  const running = new Set()
  const file = settingsFile()
  /** Effective feature switches: row config, then the persisted file, then defaults. */
  const features = { ...pickFeatures(options) }
  for (const key of FEATURE_KEYS) {
    if (typeof features[key] !== 'boolean') features[key] = DEFAULTS[key]
  }
  /** Whether the taskbar button currently shows indeterminate progress. */
  let taskbarShown = false
  let doneTimer

  const warn = (message, error) => {
    try {
      const logger = ctx.logger
      if (logger !== undefined && typeof logger.warn === 'function') {
        logger.warn(`[firefly] ${message}`, error ?? '')
        return
      }
      console.warn(`[firefly] ${message}`, error ?? '')
    } catch {
      /* logging must never break the plugin */
    }
  }

  /** Read the persisted switches; a missing or broken file keeps the defaults. */
  function loadSettings() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      Object.assign(features, pickFeatures(parsed))
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('settings file could not be read', error)
    }
  }

  /** Persist the switches; returns whether the write succeeded. */
  function saveSettings() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(pickFeatures(features), null, 2)}\n`, 'utf8')
      return true
    } catch (error) {
      warn('settings file could not be written', error)
      return false
    }
  }

  /** Whether user-facing alert output is wanted right now. */
  const wantsAlerts = () => features.alerts === true

  /** Push one JSON frame to every connected page; drop writers whose stream is gone. */
  function broadcast(frame) {
    if (frame.kind !== 'settings' && !wantsAlerts()) return
    if (subscribers.size === 0) return
    const payload = `data: ${JSON.stringify(frame)}\n\n`
    for (const send of [...subscribers]) {
      if (!send(payload)) subscribers.delete(send)
    }
  }

  /** Open one SSE response body and register its writer. */
  function openEventStream(request) {
    let controller = null
    let heartbeat = null
    let closed = false

    const send = (text) => {
      if (closed || controller === null) return false
      try {
        controller.enqueue(encoder.encode(text))
        return true
      } catch {
        return false
      }
    }

    const stop = () => {
      if (closed) return
      closed = true
      if (heartbeat !== null) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      subscribers.delete(send)
      streamStops.delete(stop)
      try {
        controller?.close()
      } catch {
        /* already closed by the carrier */
      }
    }

    return new ReadableStream({
      start(streamController) {
        controller = streamController
        subscribers.add(send)
        streamStops.add(stop)
        send(': connected\n\n')
        send(`data: ${JSON.stringify({ kind: 'settings', ...pickFeatures(features), at: Date.now() })}\n\n`)
        heartbeat = setInterval(() => {
          if (!send(': ping\n\n')) stop()
        }, 25000)
        request.signal?.addEventListener('abort', stop, { once: true })
      },
      cancel() {
        stop()
      },
    })
  }

  const eventsRoute = {
    path: EVENTS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) =>
      new Response(openEventStream(request), {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        },
      }),
  }

  const focusRoute = {
    path: FOCUS_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      if (wantsAlerts()) runHelper(TASKBAR_FOCUS)
      return new Response(null, { status: 204 })
    },
  }

  const settingsRoute = {
    path: SETTINGS_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return jsonResponse(pickFeatures(features))

      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse({ error: 'invalid-json' }, 400)
      }
      const next = pickFeatures(body)
      if (Object.keys(next).length === 0) {
        return jsonResponse({ error: 'expected a boolean "alerts" or "history"' }, 400)
      }
      Object.assign(features, next)
      const persisted = saveSettings()
      reflectTaskbar()
      if (!wantsAlerts()) clearDoneTimer()
      broadcast({ kind: 'settings', ...pickFeatures(features), at: Date.now() })
      return jsonResponse({ ...pickFeatures(features), persisted })
    },
  }

  /**
   * Run the taskbar helper once and forget it. The helper resolves the window
   * itself, so a profile without an Electron window simply exits.
   * @param action - `INDETERMINATE`, `NONE`, or `FOCUS`.
   */
  function runHelper(action) {
    if (process.platform !== 'win32') return
    const executable = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    try {
      const child = spawn(
        executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          HELPER_SCRIPT,
          String(process.ppid),
          action,
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
      child.on('error', (error) => warn('taskbar helper failed', error))
      child.unref()
    } catch (error) {
      warn('taskbar helper unavailable', error)
    }
  }

  /** Reflect the current run count and the alert switch on the taskbar button. */
  function reflectTaskbar() {
    const wanted = wantsAlerts() && options.taskbarProgress !== false && running.size > 0
    if (wanted === taskbarShown) return
    taskbarShown = wanted
    runHelper(wanted ? TASKBAR_INDETERMINATE : TASKBAR_NONE)
  }

  function clearDoneTimer() {
    if (doneTimer === undefined) return
    clearTimeout(doneTimer)
    doneTimer = undefined
  }

  loadSettings()

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      running.add(agent.id)
      reflectTaskbar()
      clearDoneTimer()
      return
    }
    if (!running.delete(agent.id)) return
    reflectTaskbar()
    if (running.size > 0) return
    if (!wantsAlerts() || options.notifyOnDone === false) return
    doneTimer = setTimeout(() => {
      doneTimer = undefined
      if (running.size === 0) broadcast({ kind: 'done', at: Date.now() })
    }, Math.max(0, Number(options.doneDelayMs) || 0))
    doneTimer.unref?.()
  })

  ctx.on(
    'approval/request',
    async (request, next) => {
      if (wantsAlerts() && options.notifyOnApproval !== false) {
        broadcast({
          kind: 'approval',
          tool: typeof request.toolName === 'string' ? request.toolName : '',
          at: Date.now(),
        })
      }
      return next()
    },
    true,
  )

  ctx.on(
    'user-questions/request',
    async (request, next) => {
      if (wantsAlerts() && options.notifyOnQuestion !== false) {
        const first = Array.isArray(request.questions) ? request.questions[0] : undefined
        broadcast({
          kind: 'question',
          header: typeof first?.header === 'string' ? first.header : '',
          at: Date.now(),
        })
      }
      return next()
    },
    true,
  )

  ctx.effect(() => ctx.connection.fetch.register(eventsRoute), 'firefly: events route')
  ctx.effect(() => ctx.connection.fetch.register(focusRoute), 'firefly: focus route')
  ctx.effect(() => ctx.connection.fetch.register(settingsRoute), 'firefly: settings route')

  ctx.effect(
    () => () => {
      clearDoneTimer()
      for (const stop of [...streamStops]) stop()
      subscribers.clear()
      running.clear()
      if (taskbarShown) runHelper(TASKBAR_NONE)
      taskbarShown = false
    },
    'firefly: taskbar cleanup',
  )
}
