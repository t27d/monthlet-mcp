// monthlet-mcp: a stdio <-> Streamable HTTP bridge for the monthlet MCP server.
//
// An MCP client (Claude Code, Claude Desktop, ...) starts this process over stdio. It relays each
// JSON-RPC message to the HTTP server that runs inside the monthlet app on this computer
// (127.0.0.1 only) and writes the response back to stdout. It does nothing else.
//
// Why a bridge instead of connecting to the HTTP server directly:
//   1. The access token never goes into the client's config. The bridge reads it from the app's
//      connection file each time, so regenerating the token in monthlet needs no client change.
//   2. The port can change (27180 by default, another free port if that one is taken). The bridge
//      looks up the current port each time it connects.
//
// No dependencies: Node.js built-in modules only. Requires Node.js 18 or later.
// This file is published as-is in https://github.com/t27d/monthlet-mcp and is also bundled inside the
// monthlet app, so keep it free of internal notes.

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const readline = require('readline')

// The connection file the app writes ({ port, token, vaultPath }). It lives in the app's user data
// folder and exists only while the MCP server in monthlet is running.
const ENDPOINT_FILE = 'mcp-endpoint.json'

function endpointFilePath(platform, env, homedir) {
  const name = 'monthlet'
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming')
    return path.join(appData, name, ENDPOINT_FILE)
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', name, ENDPOINT_FILE)
  }
  const xdg = env.XDG_CONFIG_HOME || path.join(homedir, '.config')
  return path.join(xdg, name, ENDPOINT_FILE)
}

// Every place the connection file can be, most likely first. On Windows, the Microsoft Store version
// of monthlet runs as an MSIX package, and Windows redirects what it writes to %APPDATA% into the
// package's own folder (%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming). A process outside
// the package, like this bridge, does not see that redirection, so look there as well.
function endpointFileCandidates(platform, env, homedir, listDir = safeListDir) {
  const out = [endpointFilePath(platform, env, homedir)]
  if (platform !== 'win32') return out
  const localAppData = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local')
  const packages = path.join(localAppData, 'Packages')
  for (const dir of listDir(packages)) {
    if (!dir.toLowerCase().startsWith('t27d.monthlet_')) continue
    out.push(path.join(packages, dir, 'LocalCache', 'Roaming', 'monthlet', ENDPOINT_FILE))
  }
  return out
}

function safeListDir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

// The newest connection file that exists, or the first candidate when none does (so the
// "not running" message still applies).
function findEndpointFile(candidates, statMtime = safeMtime) {
  let best = null
  let bestTime = -1
  for (const file of candidates) {
    const t = statMtime(file)
    if (t > bestTime) {
      best = file
      bestTime = t
    }
  }
  return best ?? candidates[0]
}

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return -1
  }
}

// Errors in words a person can act on. Clients show only this text in their logs, so each one says
// what is wrong and what to do next. Japanese for a Japanese system locale, English otherwise.
const MESSAGES_EN = {
  notRunning:
    'monthlet is not running, or its MCP server is off. Open monthlet and turn on Settings > Connectors > "Publish to external agents".',
  unreadable: "Couldn't read monthlet's connection file (it may be damaged). Restart monthlet.",
  unauthorized:
    'monthlet rejected the access token. Restart monthlet, or regenerate the token in Settings.',
  unreachable: "Couldn't connect to monthlet. Check that monthlet is running.",
  invalidJson: 'Could not parse the message as JSON.',
  unexpected: 'monthlet returned an unexpected response:'
}
const MESSAGES_JA = {
  notRunning:
    'monthlet が起動していないか、外部エージェントへの公開がオフです。monthlet を起動し、設定 →「コネクタ」→「外部エージェントに公開」をオンにしてください。',
  unreadable:
    'monthlet の接続情報を読めませんでした（ファイルが壊れている可能性があります）。monthlet を再起動してください。',
  unauthorized:
    'monthlet が token を受け付けませんでした。monthlet を再起動するか、設定で token を作り直してください。',
  unreachable: 'monthlet に接続できませんでした。monthlet が起動しているか確認してください。',
  invalidJson: 'JSON として解釈できませんでした',
  unexpected: 'monthlet が予期しない応答を返しました:'
}

function systemLocale(env) {
  const fromEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG
  if (fromEnv) return fromEnv
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return 'en'
  }
}

function messagesFor(locale) {
  return /^ja\b|^ja[-_]/i.test(String(locale || '')) ? MESSAGES_JA : MESSAGES_EN
}

const MESSAGES = messagesFor(systemLocale(process.env))

// Read the connection file. Missing means the app is not running (it deletes the file when it quits).
function readEndpoint(filePath) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { ok: false, message: MESSAGES.notRunning }
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, message: MESSAGES.unreadable }
  }
  if (!data || typeof data.port !== 'number' || typeof data.token !== 'string') {
    return { ok: false, message: MESSAGES.unreadable }
  }
  return { ok: true, port: data.port, token: data.token }
}

// A JSON-RPC error response. Notifications (no id) get no response, so callers drop those.
function errorResponse(id, message) {
  return { jsonrpc: '2.0', id, error: { code: -32001, message } }
}

// Pull JSON-RPC messages out of a text/event-stream body. Consecutive `data:` lines form one event and
// a blank line ends it. `event:`, `id:` and comment lines are skipped.
function parseSseMessages(body) {
  const out = []
  let buf = []
  const flush = () => {
    if (buf.length === 0) return
    const text = buf.join('\n')
    buf = []
    if (!text.trim()) return
    try {
      out.push(JSON.parse(text))
    } catch {
      // Drop data that is not JSON (clients understand JSON-RPC only)
    }
  }
  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    if (line.startsWith('data:')) {
      buf.push(line.slice(5).replace(/^ /, ''))
    }
  }
  flush()
  return out
}

// Send one request over HTTP. Returns the raw body, content type, status and session ID; the caller
// interprets them as JSON-RPC.
function postJson(port, token, sessionId, protocolVersion, payload) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(body.length),
      authorization: `Bearer ${token}`
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            ok: true,
            status: res.statusCode || 0,
            contentType: String(res.headers['content-type'] || ''),
            sessionId: res.headers['mcp-session-id'],
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('error', () => resolve({ ok: false }))
    req.end(body)
  })
}

function main() {
  const locate = () =>
    findEndpointFile(endpointFileCandidates(process.platform, process.env, os.homedir()))
  // Keep the connection details, but when the connection fails or returns 401, read the file again
  // and retry once (the token was regenerated or the port moved).
  let endpoint = null
  let sessionId
  let protocolVersion

  const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)

  const send = async (payload) => {
    if (!endpoint) {
      const resolved = readEndpoint(locate())
      if (!resolved.ok) return { failed: resolved.message }
      endpoint = resolved
    }
    let res = await postJson(endpoint.port, endpoint.token, sessionId, protocolVersion, payload)
    if (!res.ok || res.status === 401) {
      // The port or the token may have changed. Read the file again and retry once.
      const resolved = readEndpoint(locate())
      if (!resolved.ok) return { failed: resolved.message }
      endpoint = resolved
      sessionId = undefined
      res = await postJson(endpoint.port, endpoint.token, sessionId, protocolVersion, payload)
      if (!res.ok) return { failed: MESSAGES.unreachable }
      if (res.status === 401) return { failed: MESSAGES.unauthorized }
    }
    return { res }
  }

  const rl = readline.createInterface({ input: process.stdin })
  // Handle messages one at a time (stdio is a single stream; this keeps responses in order).
  let queue = Promise.resolve()
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      write(errorResponse(null, MESSAGES.invalidJson))
      return
    }
    queue = queue.then(async () => {
      const id = payload && Object.prototype.hasOwnProperty.call(payload, 'id') ? payload.id : null
      const { failed, res } = await send(payload)
      if (failed) {
        // Notifications (no id) get no response. Leave the message on stderr for a person to read.
        if (id === null) process.stderr.write(`monthlet-mcp: ${failed}\n`)
        else write(errorResponse(id, failed))
        return
      }
      if (res.sessionId) sessionId = res.sessionId
      if (payload.method === 'initialize' && payload.params?.protocolVersion) {
        protocolVersion = payload.params.protocolVersion
      }
      if (res.status === 202 || !res.body) return // A notification was accepted; nothing to return
      if (res.contentType.includes('text/event-stream')) {
        for (const msg of parseSseMessages(res.body)) write(msg)
        return
      }
      try {
        write(JSON.parse(res.body))
      } catch {
        if (id !== null) write(errorResponse(id, `${MESSAGES.unexpected} ${res.status}`))
      }
    })
  })
  // When stdin closes, finish the messages already in flight before exiting (otherwise piping a
  // request in would exit before its response is written).
  rl.on('close', () => queue.then(() => process.exit(0)))
}

module.exports = {
  endpointFilePath,
  endpointFileCandidates,
  findEndpointFile,
  readEndpoint,
  parseSseMessages,
  errorResponse,
  messagesFor,
  MESSAGES,
  main
}

// Run directly (`node monthlet-mcp.cjs`, as the plugin does) or through the bundled entry script.
if (require.main === module) main()
