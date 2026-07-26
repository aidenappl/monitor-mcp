# AGENTS.md — monitor-mcp

> The comprehensive working document for this repo. An agent that reads only this
> file should be able to work in monitor-mcp correctly. Keep it current — see
> **Keeping this file updated** at the bottom.

---

## 1. What this repo is

`monitor-mcp` is the **MCP server** that exposes the `monitor-core` admin/query API to
Claude as `mcp__monitor__*` tools. It is a single-file Node ESM program published to npm
and consumed via `npx -y monitor-mcp`, configured in `~/.mcp.json`. It is one of the
five platform MCP servers (`lattice-mcp`, `monitor-mcp`, `forta-mcp`, `keyring-mcp`,
`openbucket-mcp`), all following the same shape.

It **owns**: the tool definitions, their JSON schemas, and the HTTP mapping to
`monitor-core`. It **does not** own any data or logic — every tool is a thin call to a
`monitor-core` `/v1/*` route.

---

## 2. Stack & dependencies

- Node ESM, single file `index.js` (~960 lines).
- `@modelcontextprotocol/sdk` (MCP server) + `zod` (tool input schemas).
- Talks to `monitor-core` over `fetch` (native).

---

## 3. Project structure

```
monitor-mcp/
  index.js        # Everything: config/setup, api() helper, tool registrations, server bootstrap
  package.json    # bin: monitor-mcp; version (see §9)
  README.md
  .gitignore
```

Config: `--setup` writes `mcpServers.monitor` into `~/.mcp.json` to run `npx -y
monitor-mcp` with `MONITOR_API_URL` + `MONITOR_API_KEY` env. The server exits if either
is missing (`index.js:54-58`).

---

## 4. Running, building & testing

```bash
node index.js --setup        # write ~/.mcp.json entry (interactive)
MONITOR_API_URL=… MONITOR_API_KEY=… node index.js   # run directly (stdio MCP)
```

There is no build step and no test suite. **Publishing is deployment** — `npx -y`
resolves latest, so a published version is live for new clients; a running MCP server
must be restarted to pick up a new version. Publishing requires 2FA via passkey from an
interactive terminal.

---

## 5. How code is written here — the golden rule

**When adding or changing a tool, READ the `monitor-core` handler — never infer the
request shape from a description or a struct.** Every bug shipped across the five MCP
servers came from that: wrong units, wrong enum values, wrong content type, or params
the handler silently ignores. The relevant handlers live in
`monitor-core/routes/*.go`, `monitor-core/alerts/alerts.go`, and
`monitor-core/services/query.go`. The route table is `monitor-core/main.go:155-242`.

Shape rules verified correct in this repo (keep them):
- **Auth:** every request sends `X-Api-Key: <MONITOR_API_KEY>`. This must
  be an **admin-scope** DB key or the env master key — ingest-scope keys get 403 on
  `/v1/*`. (State this in setup docs.) The `/v1/*` routes authenticate via
  `QueryAuthMiddleware`, which honours the X-Api-Key.
- **Session-only routes:** `/admin/sso-providers*` and `/auth/self*` sit behind
  monitor-core's `SessionMiddleware` (+ `RequireAdmin` for the SSO admin CRUD), which
  accepts **only** an `Authorization: Bearer <access-jwt>` or the `mon-access-token`
  cookie — **X-Api-Key is NOT honoured there** (see `middleware/session.go` vs
  `middleware/query_auth.go` in monitor-core). The SSO/self tools therefore also send a
  Bearer header when the optional `MONITOR_SESSION_TOKEN` env var (an admin access JWT)
  is set; without it those tools return 401/403. The public `GET /auth/sso/config` needs
  no auth at all.
- **`query_filters` and `notification_channel_ids` are JSON *strings*, not arrays** —
  `monitor-core`'s `Rule` struct types them as Go `string` (`alerts.go:34,42`). Send
  stringified JSON.
- **Enums** (must match `monitor-core`): alert `type` ∈ threshold/absence/rate_change;
  `condition` ∈ gt/lt/gte/lte/eq; `metric` ∈ count/sum/avg/min/max (⊂ AggregationType);
  `priority` ∈ P0–P3; issue `status` ∈ unresolved/resolved/ignored; api-key `scope` ∈
  admin/ingest; label names ∈ service/env/name/level/user_id.
- **Body vs query:** analytics/timeseries/topn/gauge/compare are POST-body; events/labels/
  data/trace/request are GET-query; issue/api-key/alert-rule mutations use path + body.

**House rule:** any new `monitor-core` `/v1/*` route should add or consciously skip a
tool here in the same change. See §7 for the current gaps.

---

## 6. Tool inventory (42 tools)

Discovery/query: `monitor_health`, `monitor_list_services|environments|event_names|
levels|users`, `monitor_get_data_keys|data_values`, `monitor_search_events`,
`monitor_count`, `monitor_analytics`, `monitor_timeseries`, `monitor_topn`,
`monitor_compare`, `monitor_trace`, `monitor_request`, `monitor_recent_errors`,
`monitor_error_breakdown`, `monitor_error_trend`, `monitor_service_overview`.

Issues: `monitor_list_issues`, `monitor_get_issue`, `monitor_update_issue`,
`monitor_get_issue_events`.

API keys: `monitor_list_api_keys`, `monitor_create_api_key`, `monitor_delete_api_key`.

Alerts: `monitor_list_alert_rules`, `monitor_test_alert_rule`, `monitor_create_alert_rule`,
`monitor_update_alert_rule`, `monitor_delete_alert_rule`, `monitor_list_alert_history`.

Notification channels: `monitor_list_notification_channels`,
`monitor_create_notification_channel`, `monitor_delete_notification_channel`.

SSO / auth (added 2026-07-24, verified against `monitor-core/routes/HandleSSOConfig.router.go`,
`HandleAdminSSOProviders.router.go`, `HandleGetSelf.router.go` + `RegisterSSORoutes.go`):
`monitor_get_sso_config` (GET /auth/sso/config — public), `monitor_list_sso_providers`
(GET /admin/sso-providers), `monitor_create_sso_provider` (POST /admin/sso-providers),
`monitor_update_sso_provider` (PUT /admin/sso-providers/{slug} — partial),
`monitor_delete_sso_provider` (DELETE /admin/sso-providers/{slug}), `monitor_get_self`
(GET /auth/self). SSO admin CRUD + get_self are **session-gated** (Bearer JWT via
`MONITOR_SESSION_TOKEN`, X-Api-Key rejected — see §5). Provider `kind` ∈ oidc/oauth2;
`client_secret` is plaintext/write-only (encrypted at rest, never returned — response
exposes only `has_secret`); provide `client_secret` OR `client_secret_ref`, not both;
`scopes` is a space-separated string.

The first 36 methods/paths/enums verified against the live `monitor-core` handlers
(2026-07-23). Notification-channel `config` is a JSON *string* (`Channel.Config` is Go
`string`, `alerts.go:81`); `type` ∈ webhook/slack/email/pagerduty (`CreateChannel`,
`alerts.go:485`).

---

## 7. Coverage gaps (routes with no tool)

Per the house rule, these `monitor-core` routes have **no MCP tool** — decide add-or-skip:

| Route(s) | Assessment |
|---|---|
| `POST /v1/notification-channels/{id}/test` | Minor skip — list/create/delete are now covered (`monitor_list|create|delete_notification_channel`); the test-send route has no tool yet. Add or leave skipped. |
| `/v1/service-groups`, `/v1/notification-policies` | Gap — routing config unreachable via MCP. Add or document as skipped. |
| `GET /v1/alert-rules/{id}` | Minor — `list` covers it. |
| `/v1/dashboards`, `/v1/views` | Likely intentional skip (UI persistence, not agent-facing). Document as skipped. |
| `POST/DELETE /auth/self/identities/{slug}` (link/unlink) | Skipped — these are interactive browser account-LINK flows (link returns an IdP `authorize_url` to redirect the user through), not agent-driven API calls. `GET /auth/self/identities` is covered indirectly (identities are included in `monitor_get_self`). |
| `GET /self` (legacy `/v1`) | Minor skip. Note: the new `GET /auth/self` IS covered by `monitor_get_self` (session-gated). |
| `/v1/events/stream`, `/v1/alerts/stream` (SSE) | Correctly skipped (streaming; also broken today — monitor-core AGENTS §9 B1). |
| `POST /v1/events` (ingest) | Correctly skipped (SDK's job). |

---

## 8. Ecosystem & related repos

| Repo | Relationship |
|---|---|
| `monitor-core` | The API this wraps. Handlers are the source of truth for every tool's shape. |
| `monitor-web` | Alternate client over the same API (the human UI). |
| `lattice-mcp` / `forta-mcp` / `keyring-mcp` / `openbucket-mcp` | Sibling MCP servers, same shape. |

---

## 8a. Sensitive value masking

`api()` passes every decoded JSON response through **`sanitise()`** before returning it. This is
central, not per-tool, so a newly added tool is safe by default rather than by remembering.

`mask()` keeps a value's **first two characters** and appends a **fixed-width tail** —
`"supersecret"` → `"su**********"`. The prefix is what makes the mask useful rather than merely
safe: you can still tell one credential from another, or confirm a rotation changed a value.
The tail is fixed width so the mask does not disclose the real length. Values under three
characters are masked whole. The same shape is implemented in all five `*-mcp` servers.

`monitor-core` already keeps SSO client secrets write-only — `/admin/sso-providers` returns only
`has_secret` — so the gap this closes is **`monitor_create_api_key`**, which returns a full
admin or ingest key once, and that key can read every event the platform holds. `key_prefix` is
deliberately *not* masked: it is a non-secret identifier for matching a key to its record, and
masking it would defeat the point of listing keys.

**Event payloads are not walked.** `data`, `context`, `extra` and `tags` pass through intact.
They are free-form and come from instrumented services; a key-name heuristic over them produces
noise without producing safety. If a service logs a secret into an event, it will still surface
here — **that is a bug in the emitting service and the fix belongs there**, not in a guess about
payload shape.

`MONITOR_ALLOW_SECRET_VALUES=1` disables masking. It is off by default and should stay that way.

---

## 9. Rules & guardrails + known issues

**Rules**
- Read the `monitor-core` handler before adding/changing a tool (§5).
- Keep `query_filters`/`notification_channel_ids` as JSON strings.
- `server.version` is read from `package.json` at startup — bump only `package.json`.
- Any new `monitor-core` route → add or consciously skip a tool here.
- **Never weaken `sanitise()`** (§8a) — it must stay recursive, applied centrally in `api()`, and
  on by default. If something genuinely needs a real value, the answer is
  `MONITOR_ALLOW_SECRET_VALUES=1` in that server's env, not an exemption in the code.

**Known issues & gaps** — all resolved in the 2026-07-23 fix pass (kept here for traceability):

| ID | Sev | Where | Status |
|---|---|---|---|
| C1 | 🔴 | `monitor_update_alert_rule` | ✅ **Fixed.** The handler now strips all `undefined` params and only sends fields the caller provided — omitting `enabled` no longer sends `false`. Belt-and-suspenders with the monitor-core fix making PUT preserve `enabled` when omitted. Description updated to state omitted fields are left unchanged. |
| G1 | 🟡 | notification channels | ✅ **Fixed.** Added `monitor_list_notification_channels` (GET), `monitor_create_notification_channel` (POST — `name`, `type`, `config` JSON string), `monitor_delete_notification_channel` (DELETE). Shapes verified against `routes/alerts.go` + `alerts.Channel`/`CreateChannel`. |
| C2 | 🟢 | `api()` | ✅ **Fixed.** `api()` now checks `res.ok`, reads the body as text, JSON-parses when possible, and on non-ok returns an object carrying `http_status` and the body (parsed or raw). |
| C3 | 🟢 | `api()` URL build | ✅ **Fixed.** URL is now `API_URL` (trailing slash stripped) + leading-slash path, so a base like `https://host/basepath` is preserved. |
| C4 | 🟢 | `server.version` | ✅ **Fixed.** `server.version` now reads from `package.json` at startup (currently `1.0.3`). Package version not bumped. |
| C5 | 🟢 | `monitor_get_issue_events` | ✅ **Fixed.** `limit` description now reads "default 50, max 500" to match the handler. |

---

## 10. Verification

`node index.js --setup` (writes config) and a manual smoke test against a running
`monitor-core` with a valid **admin-scope** key. There is no automated test suite; when
adding a tool, verify the request against the real handler (§5) and exercise it once
end-to-end before publishing.

---

## 11. Keeping this file updated

Any change to the tool set, a tool's request shape, auth, or config MUST update this file
in the same change. When a §9 finding is fixed, delete its row. When a `monitor-core`
route is added, update §6/§7 here.
