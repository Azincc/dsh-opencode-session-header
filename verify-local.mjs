// Offline unit check for the local bundle: no network, no globals touched.
// usage: node verify-local.mjs
import assert from 'node:assert/strict'
import { apply } from './index.js'

const handlers = {}
const ctx = {
  logger: { warn() {} },
  on(name, fn) { handlers[name] = fn },
}
apply(ctx, { header: 'x-opencode-session', modelPrefixes: ['go/'], overwriteHeaders: [] })

const call = (request, initial) => {
  const headers = new Headers(initial)
  const merged = handlers['llm-pi-ai/request-headers'](
    {
      provider: 'az1n',
      model: 'go/deepseek-v4.1-flash',
      baseURL: 'https://api-dir.az1n.com/v1',
      ...request,
    },
    headers,
    () => headers,
  )
  return merged.get('x-opencode-session')
}

try {
  // Live session id, prefix stripped.
  assert.equal(call({ sessionId: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  assert.equal(call({ sessionId: 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

  // Gate: a non-go model on the same route never receives it.
  assert.equal(call({ model: 'gemini-3.5-flash-lite', sessionId: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), null)

  // No session id -> no header (nothing to route by).
  assert.equal(call({ sessionId: undefined }), null)

  // A header some other layer already set is preserved.
  assert.equal(call({ sessionId: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { 'x-opencode-session': 'placeholder' }), 'placeholder')

  // Fixed value wins over the live id when configured.
  const fixedHandlers = {}
  apply({ logger: { warn() {} }, on(name, fn) { fixedHandlers[name] = fn } },
    { header: 'x-opencode-session', value: 'fixed-value', modelPrefixes: ['go/'] })
  const headers = new Headers()
  fixedHandlers['llm-pi-ai/request-headers'](
    { provider: 'az1n', model: 'go/deepseek-v4.1-flash', baseURL: 'https://api-dir.az1n.com/v1', sessionId: 'session-x' },
    headers, () => headers)
  assert.equal(headers.get('x-opencode-session'), 'fixed-value')

  // Unparseable endpoint prefixes fail closed instead of matching everything.
  const gated = {}
  apply({ logger: { warn() {} }, on(name, fn) { gated[name] = fn } },
    { header: 'x-opencode-session', endpoints: ['not a url'] })
  const gatedHeaders = new Headers()
  gated['llm-pi-ai/request-headers'](
    { provider: 'az1n', model: 'go/x', baseURL: 'https://api-dir.az1n.com/v1', sessionId: 'session-x' },
    gatedHeaders, () => gatedHeaders)
  assert.equal(gatedHeaders.get('x-opencode-session'), null)

  console.log(JSON.stringify({
    passed: true,
    sessionIdStripped: true,
    modelGate: true,
    noSessionNoHeader: true,
    existingHeaderPreserved: true,
    fixedValue: true,
    endpointFailClosed: true,
    networkRequests: 0,
  }))
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
