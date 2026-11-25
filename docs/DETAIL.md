# Gateway session header

CPA / OpenCode Go rejects a chat request with `MissingSessionID` unless the HTTP header
`x-opencode-session` carries the conversation's id. DSH has no per-request header setting:
each LLM adapter builds its own wire headers, and a fixed value in provider config would make
every conversation look like one session.

This plugin wraps the two seams that together cover every LLM call:

- the `llm/stream` waterfall, which identifies LLM calls and carries `options.sessionId`;
- `globalThis.fetch`, which every fetch-based adapter bottoms out in.

Each step of the adapter's stream resumes inside an `AsyncLocalStorage` scope, so the
adapter's own `fetch` sees the session id of that exact call, while unrelated fetches
(browser RPC, telemetry, tools) pass through untouched. Unloading the plugin restores the
original `fetch`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `header` | `x-session-id` | Header name to inject. |
| `value` | live session id | Fixed value instead of the live id. Leave unset. |
| `endpoints` | empty = every LLM request | URL prefixes that may receive the header. Set to the gateway address. |
| `toolEndpoints` | empty = no tool fetch | URL prefixes matched during tool execution. |
| `overwriteHeaders` | empty | Headers this plugin may replace when another layer already set one. |

The shipped `cordis.patch.yml` configures `header: x-opencode-session` and
`endpoints: [https://api-dir.az1n.com/v1]`.

## Notes

- The live DSH session id loses its `session-` prefix, so the wire value is a plain UUID.
- A header already present is never overwritten unless listed in `overwriteHeaders`.
- Title-generation and compaction calls are LLM calls too; they report their own session,
  which is expected and harmless.
- The plugin does not and cannot influence the gateway's next hop.
