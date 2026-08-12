# @simplepush/mcp

MCP server for Simplepush. An agent sends tasks and notifications to people's phones and waits for the answers, appends follow-ups, cancels mistakes, and queries the record of everything that came back. Tasks, answers, replies, declines, and ad-hoc submissions stay queryable, so the stream doubles as a knowledge base of the work: what was asked, who answered what, and what is still open.

## Tools

| Tool | What it does |
|---|---|
| `send_notification` | Push for alerts and heads-ups. Can carry one `input` (a text input, a choice, or action buttons); returns right after sending unless `wait_seconds` is set. A copy per recipient by default — the result lists one `notification_id` per person; `shared: true` sends one all recipients see. |
| `send_task` | Sends a task and waits for the answers. Takes the full input set (text, choice, actions, slider, photo, voice recording, file, location), a `tag`, a `reply` mode, `expires_at`, Markdown and links. A copy per recipient by default: waits for everyone, reports per-recipient results with the rest pending at the deadline. `shared: true` sends one task all recipients answer together, first answer wins. Every result carries the `append_token`. |
| `append_subtask` | Appends a follow-up question or checklist item to a task or group, using the `append_token` from `send_task`. Never waits. |
| `cancel_task` | Withdraws a task (`tsk_`), subtask (`sub_`) or whole group (`grptsk_`) by id, with an optional reason and note. |
| `get_task_answer` | Resolves a `task_id` from an earlier `send_task`, or a `subtask_id` from `append_subtask`. |
| `get_notification_answer` | Resolves what came back on a `notification_id` from an earlier `send_notification` with an input. |
| `query_tasks` | One page of tasks as summaries: tag, topic, status, recipients, input kinds, attachment kinds, reply mode, sent time, subtask counts. Filters: status, time window, topic, member, group. |
| `get_task` | One task with all its subtasks: questions, answers, replies, declines, file ids. |
| `get_group_status` | Per-recipient status of a task group (`grptsk_`): who has answered, who has not. |
| `query_events` | The org's activity history: answers, replies, submissions, declines, cancellations, expiries, with who and when. Last 7 days by default. |
| `query_submissions` | Ad-hoc reports from the field (text, photo, file, voice, location), with who and when. Last 7 days by default. |
| `search_knowledge` | Full-text and location search over everything: tasks and notifications, what people answered and replied, and ad-hoc submissions, across all time. Literal word matching, plus stemming in up to three languages; or a coordinate plus radius (or a polygon of corner points), returning the locations recorded within it, nearest first. Each hit carries the id to read in full (a group send hits once, as its `grptsk_` id) and a snippet or a point with its distance. Plaintext records only. |
| `get_activity` | Everything going on for one member or the whole org in one call: open/declined/expired tasks plus the window's answers, replies, declines, cancellations and submissions. The tool for "any problems with X?" and "catch me up". |
| `download_attachment` | Fetches a photo, voice recording or file by `scope_id` (the tsk_/sub_/sbm_ id it belongs to) and `file_id` (an answer's inputId, a reply or submission file's id). Images are returned inline. |

The query tools work in both modes: an integration token reads the whole organization, an API token reads your personal stream (subscription required on personal accounts). On the hosted transport they need the `read` scope; `download_attachment` additionally needs `files:read`. Encrypted content is decrypted with the keys the server holds; anything it cannot open is left as ciphertext and reported.

A timeout in `send_task` is not a cancellation. The questions stay live on the phones, and answers are available later via `get_task_answer` or `get_group_status`. `inputs` says how the task is answered: text, single or multi choice, action buttons, slider, photo, voice recording, file, location. `send_task` waits 90 seconds by default; per-call `wait_seconds` raises that, up to `SP_MAX_WAIT_SECONDS`.

## Setup

The server runs in one of two modes, decided by which credential you set.

### Personal mode

Get an API token from the API Token screen in the Simplepush app, then:

```json
{
  "mcpServers": {
    "simplepush": {
      "command": "npx",
      "args": ["-y", "@simplepush/mcp"],
      "env": { "SP_API_TOKEN": "your-token" }
    }
  }
}
```

Or with Claude Code:

```
claude mcp add simplepush --env SP_API_TOKEN=your-token -- npx -y @simplepush/mcp
```

Messages go to your own devices. Pass a `topic` to deliver to that topic's holders instead, as a single shared task where the first answer wins.

### Organization mode

Create an integration token with the CLI (admin vault unlocked):

```
sp integration create
```

```
claude mcp add simplepush --env SP_INTEGRATION_TOKEN=spi_... -- npx -y @simplepush/mcp
```

Org mode unlocks full targeting: every send takes exactly one of `topic`, `member` (name or `usr_` id), or `broadcast`. If the org has encryption enabled, the token's second half unwraps the org master keys at startup and all sends are end-to-end encrypted; answers are decrypted the same way.

If both credentials are set, the integration token wins and a note goes to stderr. MCP clients spawn stdio servers with your shell environment attached, so an exported `SP_API_TOKEN` from unrelated CLI work rides along; setting `SP_INTEGRATION_TOKEN` is always deliberate.

### Environment variables (stdio)

| Variable | Default | Meaning |
|---|---|---|
| `SP_API_TOKEN` | one credential required | Personal API token from the app. |
| `SP_INTEGRATION_TOKEN` | one credential required | Org integration token from `sp integration create`. |
| `SP_KEYS` | unset | Personal encryption keys, see below. |
| `SP_BASE_URL` | `https://api.simplepu.sh` | API origin. Point at `http://localhost:8000` for local development. |
| `SP_MAX_WAIT_SECONDS` | `900` | Ceiling on how long `send_task` may block. Per-call `wait_seconds` is clamped to it. |
| `SP_POLL_INTERVAL_MS` | `2000` | Gap between answer polls while blocking. |

## Encryption

Org mode encrypts automatically when the org has encryption enabled, as described above.

Personal sends are plaintext unless you provide keys. Encrypted and plaintext tasks are distinguishable at a glance in the app: encrypted ones carry the lock icon.

Keys are exported from the Simplepush app: Copy Key for Integrations on the Encryption screen for the Personal Password key, and the copy action next to a topic on the Topics screen for topic keys.

`SP_KEYS` is a comma-separated list. A bare base64 key is the Personal Password key, used for self-sends. `topic=key` binds a key to one topic:

```
SP_KEYS="AbC...="                        # default key only
SP_KEYS="alerts=AbC...=,deploys=XyZ...="  # two topic keys
SP_KEYS="AbC...=,alerts=XyZ...="          # both
```

With a matching key, sends to that target are encrypted and answers are decrypted. An answer the server holds no key for comes back with `undecryptable: true` rather than silently wrong.

Keys only. There is no `SP_PASSWORD`.

## Hosted HTTP transport

`simplepush-mcp-http` serves the same tools over Streamable HTTP as an OAuth resource server. No ambient credential: each request carries its own access token, verified by introspection against the authorization server and audience-checked against `SP_CANONICAL_URI`. Discovery metadata is served at `/.well-known/oauth-protected-resource`; the MCP endpoint is `/mcp`. `GET /status` is a public summary for uptime monitoring: 200 when the authorization server and the API both answer, 503 otherwise, with the same shape as the backend's `/v1/status`. Tool calls are scope-gated: `send` for `send_notification`, `send_task`, `append_subtask` and `cancel_task`, `read` for the answer and query tools, `files:read` for `download_attachment`.

Hosted mode is personal OAuth grants only. Integration tokens are not accepted there by design, and hosted sends are plaintext: a server that could decrypt for you would not be end-to-end.

| Variable | Default | Meaning |
|---|---|---|
| `SP_INTROSPECTION_SECRET` | required | Bearer for the AS introspection endpoint. Must match the backend's `oauth.introspectionSecret`. |
| `SP_CANONICAL_URI` | required | Public URL clients reach this server at, e.g. `https://mcp.simplepu.sh/mcp`. Tokens are audience-bound to it. |
| `SP_OAUTH_ISSUER` | `https://api.simplepu.sh` | Origin of the authorization server, as clients see it. |
| `SP_AUTH_SERVER_URL` | `SP_OAUTH_ISSUER` | Where this server reaches the authorization server for token introspection. Set it when the backend is closer on an internal address. |
| `SP_BASE_URL` | `https://api.simplepu.sh` | API origin this server calls. |
| `SP_MCP_PORT` | `8787` | Listen port. |

## Development

```
npm install
npm run build
npm run typecheck
```

Smoke-test against a local backend without an MCP client:

```
npx @modelcontextprotocol/inspector --cli node dist/index.mjs \
  -e SP_API_TOKEN=testtoken5678 -e SP_BASE_URL=http://localhost:8000 \
  --method tools/list
```

Note that the Inspector does not forward your shell environment to the spawned server. Pass credentials with `-e`, not by exporting them.
