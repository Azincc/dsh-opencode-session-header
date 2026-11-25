# dsh-opencode-session-header

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Host bundle that adds the
`x-opencode-session` HTTP header — carrying the id of the DSH session that made the call — to
LLM requests, so a CPA / OpenCode Go gateway can route and bill each conversation separately.

[中文说明](#中文说明)

## Why

OpenCode Go's gateway rejects chat requests without that header:

```
400 {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session ..."}}
```

DSH has no per-request header setting: `GenerateOptions` carries no headers, and a fixed value in
provider config would make every conversation look like one session (and break per-session routing).
Other models on the same gateway work without the header, so injecting it globally is not desirable
either.

## How it works

`@deepseek-ai/dsh-llm-pi-ai` exposes the supported seam for exactly this: the synchronous
`llm-pi-ai/request-headers` waterfall. Each inference call passes immutable routing metadata
(`provider`, `model`, resolved `baseURL`, optional `sessionId` / `purpose`) and a fresh `Headers`
copy owned by that one dispatch. This bundle adds one header to that copy:

- the live DSH session id loses its `session-` branding prefix, so a plain UUID goes on the wire;
- optional gates (all empty by default, ANDed when set) limit injection to the routes that need it;
- a header another layer already set is preserved unless listed in `overwriteHeaders`;
- nothing is written to the Session log, messages, or tool schemas, and no global object is patched.

Because the metadata belongs to the prepared call, concurrent sessions and live configuration
changes cannot exchange header state.

## Configuration

The bundle's `cordis.patch.yml` ships a working default for an OpenCode Go route:

```yaml
- insert:
    - id: session-header
      name: '@local/dsh-session-header'
      config:
        header: x-opencode-session
        modelPrefixes:
          - go/
```

| Field | Default | Meaning |
|---|---|---|
| `header` | `x-session-id` | Header name to inject. |
| `value` | live session id | Fixed value instead of the live id. Leave unset unless the gateway wants one constant. |
| `endpoints` | empty = any URL | URL prefixes (origin + path) that may receive the header. Unparseable entries fail closed. |
| `providers` | empty = any route | pi-ai provider route names (e.g. `az1n`). |
| `modelPrefixes` | empty = any model | Model id prefixes (e.g. `go/`). |
| `overwriteHeaders` | empty | Header names this plugin may replace when already present. |

Edit the patch after installing, then reload the profile. `endpoints`, `providers`, and
`modelPrefixes` are independent gates; set only the ones you need.

## Install

Requires a DSH build whose `dsh-llm-pi-ai` exposes the `llm-pi-ai/request-headers` waterfall
(verified on DSH 0.2.2-rc.5 Desktop).

1. Clone this repository somewhere stable.
2. In DSH, open **Plugins** → **Add plugin** and pick the cloned directory, or run
   `plugin_manager` `install_bundle` with its absolute path.
3. Keep the directory where it is: a local directory install is a `link:` dependency, so moving or
   deleting it disables the plugin.

The package is intentionally named `@local/dsh-session-header` and is not published to npm.

## Verify

```sh
node verify-local.mjs
```

An offline unit check (no network, no globals): live id stripping, model gate, no-session behavior,
existing-header preservation, fixed value, and fail-closed endpoint parsing.

End-to-end on a real DSH: point an offline provider at a local mock that answers
`400 MissingSessionID` unless the header is present, send two messages in one session and one in a
new session, and confirm the mock sees one id reused and one new id.

## Compatibility and limits

- Only the pi-ai adapter is covered (`openai-completions`, `anthropic-messages`, and other pi-ai
  protocols). The direct `dsh-llm-deepseek` adapters are not.
- Auxiliary calls (session title, compaction) are covered too; they report their own session id,
  which is expected.
- If a future DSH release renames or removes this waterfall, the plugin stops injecting silently and
  the gateway error returns. Re-run `node verify-local.mjs` against the new build to check.
- The plugin cannot influence the gateway's own next hop.

## License

MIT. Derived from [homily707/dsh-session-header](https://github.com/homily707/dsh-session-header)
0.2.1; see [LICENSE](LICENSE) for both copyright notices and the list of changes.

---

## 中文说明

DSH（DeepSeek Harness）的 Host 插件，给发往 CPA / OpenCode Go 网关的 LLM 请求加上
`x-opencode-session`——值为发起该次调用的 DSH 会话 id 的 UUID。缺少它网关会返回
`400 MissingSessionID`。

DSH 没有"逐请求自定义头"的配置项，固定值又会让所有会话共用一个 id，因此这里用官方提供的
`llm-pi-ai/request-headers` 瀑布（DSH 0.2.2）在每次请求上注入：拿到的是这一次调用的
provider / model / baseURL / sessionId，并发会话不会串号，也不改任何全局对象。

默认只对 `go/*` 模型注入（`modelPrefixes: [go/]`），同一网关上的其它模型不受影响；可用
`endpoints`、`providers` 进一步收窄。安装：**插件 → 添加插件** 选择本目录，或让 agent 用
`plugin_manager install_bundle` 安装。目录是 `link:` 依赖，装好后不要移动或删除。

自检：`node verify-local.mjs`（离线，不联网）。
