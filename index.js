/**
 * Inject one HTTP header (default `x-session-id`, here `x-opencode-session`)
 * onto every pi-ai LLM request, carrying the harness session id of that exact
 * call — so turns, compaction/title helper calls, and in-process subagent
 * children each report their own session.
 *
 * The harness has no per-request header field on `GenerateOptions`; a fixed
 * value in provider config would make every conversation look like one
 * session. `@deepseek-ai/dsh-llm-pi-ai` exposes the supported seam for this:
 * the synchronous `llm-pi-ai/request-headers` waterfall, which receives the
 * prepared call's provider, model, resolved `baseURL` and `sessionId` plus a
 * fresh `Headers` copy owned by that one dispatch. Editing that copy keeps the
 * header out of messages, tool schemas, and the Session log, and it cannot
 * leak into a concurrent call or a configuration change.
 *
 * Optional gates (all ANDed, each empty by default) restrict injection to the
 * routes that actually need it:
 *
 * - `endpoints` — URL prefixes of the gateway;
 * - `providers` — pi-ai provider route names;
 * - `modelPrefixes` — model id prefixes (e.g. `go/`).
 *
 * A fixed value can be configured instead of the live session id (sent
 * verbatim); the live id's `session-` branding prefix is stripped so a plain
 * UUID goes on the wire. Calls with neither a configured value nor a session
 * id get no header. A header anyone else already set is never overwritten
 * (`Headers` matching is case-insensitive, the same rule the wire uses) unless
 * listed in `overwriteHeaders`.
 *
 * Local bundle derived from homily707/dsh-session-header 0.2.1 (MIT): the
 * upstream version patches `globalThis.fetch` and imports
 * `@deepseek-ai/schemastery`; this version uses the harness's per-request
 * waterfall seam instead, so it needs no dependencies and touches no global.
 *
 * @module dsh-session-header
 */

export const name = 'dsh-session-header'

// Hard dependency: nothing to do until the llm runtime exists.
export const inject = ['llm']

const stringArray = (input) =>
  Array.isArray(input) ? input.filter((item) => typeof item === 'string' && item.length > 0) : []

/**
 * Defaults and shape checks formerly expressed as a schemastery `Config`.
 * The harness validates a row's config only when the plugin exports one, so this
 * bundle stays dependency-free and normalizes the same fields itself.
 */
function normalizeConfig(config) {
  const raw = config ?? {}
  return {
    header: typeof raw.header === 'string' && raw.header.length > 0 ? raw.header : 'x-session-id',
    value: typeof raw.value === 'string' ? raw.value : undefined,
    endpoints: stringArray(raw.endpoints),
    providers: stringArray(raw.providers),
    modelPrefixes: stringArray(raw.modelPrefixes),
    overwriteHeaders: stringArray(raw.overwriteHeaders),
  }
}

/**
 * Plugin entry: one `llm-pi-ai/request-headers` listener. `ctx.on` removes it
 * when the owning fiber unloads, so no other cleanup is required.
 */
export function apply(ctx, rawConfig) {
  const { header, value: fixedValue, endpoints, providers, modelPrefixes, overwriteHeaders } =
    normalizeConfig(rawConfig)

  // Only one question is ever asked of `overwriteHeaders`: may we replace OUR
  // header? Case-insensitive match, the same rule the wire uses.
  const mayOverwrite = overwriteHeaders.some((name) => name.toLowerCase() === header.toLowerCase())

  // Pre-compile URL prefixes into origin-anchored matchers so a prefix can never
  // match a sibling domain: `https://gateway.example.com` must not match
  // `https://gateway.example.com.evil.io/x`. The URL parser normalizes host
  // casing and default ports; the path comparison then enforces a boundary
  // character so `/v1` matches `/v1/chat/completions` but not `/v10`. Unparseable
  // or non-http(s) prefixes are dropped (fail closed: a broken prefix simply
  // never matches, so no header is sent).
  const endpointMatchers = endpoints
    .map((prefix) => {
      let parsed
      try {
        parsed = new URL(prefix)
      } catch {
        ctx.logger.warn(`dsh-session-header: ignoring unparseable endpoint ${JSON.stringify(prefix)}`)
        return undefined
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.logger.warn(`dsh-session-header: ignoring non-http(s) endpoint ${JSON.stringify(prefix)}`)
        return undefined
      }
      return { origin: parsed.origin, path: parsed.pathname }
    })
    .filter((entry) => entry !== undefined)

  // Configured-but-unparseable prefixes stay fail-closed: the gate is "on" but
  // no matcher can ever match, so no header is sent.
  const endpointGate = endpoints.length > 0
  const providerSet = new Set(providers)

  const urlMatchesEndpoint = (input) => {
    if (input === undefined) return false
    let target
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
      if (typeof raw !== 'string') return false
      target = new URL(raw)
    } catch {
      return false
    }
    return endpointMatchers.some(({ origin, path }) => {
      if (target.origin !== origin) return false
      if (path === '/') return true
      const pathname = target.pathname
      return (
        pathname === path ||
        (pathname.startsWith(path) &&
          (path.endsWith('/') || pathname[path.length] === '/' || pathname[path.length] === '?' || pathname[path.length] === '#'))
      )
    })
  }

  // A configured value is sent verbatim; a live id loses the `session-`
  // branding prefix; no id at all means "no header".
  const resolveValue = (id) =>
    fixedValue ?? (id === undefined ? undefined : String(id).replace(/^session-/, ''))

  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    // Always continue the chain first: this listener only adds one header, and
    // the returned Headers is the copy later contributors and attribution use.
    const merged = next()
    if (providerSet.size > 0 && !providerSet.has(request.provider)) return merged
    if (modelPrefixes.length > 0) {
      const model = request.model
      if (typeof model !== 'string' || !modelPrefixes.some((prefix) => model.startsWith(prefix))) {
        return merged
      }
    }
    if (endpointGate && !urlMatchesEndpoint(request.baseURL)) return merged
    const value = resolveValue(request.sessionId)
    if (value === undefined) return merged
    if (merged.has(header) && !mayOverwrite) return merged
    merged.set(header, value)
    return merged
  })
}
