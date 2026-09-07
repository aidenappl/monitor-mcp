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

- Node ESM, single file `index.js` (~1560 lines).
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
`monitor-core/services/query.go`. The route table is `monitor-core/main.go:237-374` (as of
monitor-core `9cab9e2`); tenancy enforcement is `monitor-core/middleware/query_auth.go`.

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
- **Tenancy:** no tool takes a `project`, and adding one would be a silently-ignored
  input. The project is derived from the api_keys row behind `MONITOR_API_KEY`. Full
  reasoning in **§6a** — read it before touching anything project-shaped.

**House rule:** any new `monitor-core` `/v1/*` route should add or consciously skip a
tool here in the same change. See §7 for the current gaps.

---

## 6. Tool inventory (55 tools)

Tenancy/registry (added 2026-09-07, verified against
`monitor-core/routes/HandleListZones.router.go` and `HandleListProjects.router.go`):
`monitor_list_zones` (GET /v1/zones), `monitor_list_projects`
(GET /v1/zones/{zone}/projects). Three things to get right, all from the handlers:

- **`monitor_list_projects` returns an OBJECT, not an array** —
  `{"projects": [...], "default_project_slug": "..."}` (`ListProjectsResponse`). The
  default is a property of the INSTALL (`env.DefaultProjectSlug`), not of a row, and is
  **not** necessarily the project this server reads — see §6a.
- **`limit`/`offset` are REFUSED, not clamped.** `registryListPage` 400s on a
  non-integer, on `limit <= 0 || limit > 500`, and on a negative offset. Omitting `limit`
  asks for `db.MAX_LIMIT` (500), not the usual `DEFAULT_LIMIT` (50), deliberately: a 51st
  project silently missing from a switcher is a tenant nobody can reach.
- **The `zone` is a path segment and is required** — a project slug is unique only within
  its zone.

Discovery/query: `monitor_health`, `monitor_list_services|environments|event_names|
levels|users`, `monitor_get_data_keys|data_values`, `monitor_search_events`,
`monitor_count`, `monitor_analytics`, `monitor_timeseries`, `monitor_topn`,
`monitor_compare`, `monitor_trace`, `monitor_request`, `monitor_recent_errors`,
`monitor_error_breakdown`, `monitor_error_trend`, `monitor_service_overview`.

Issues — the error-tracking surface (expanded 2026-08-25, verified against
`monitor-core/routes/issues.go`, `issue_timeline.go` and `service_repos.go`):
`monitor_list_issues`, `monitor_get_issue`, `monitor_update_issue`,
`monitor_get_issue_events`, `monitor_get_issue_timeline`, `monitor_get_issue_history`,
`monitor_add_issue_comment`, `monitor_edit_issue_comment`, `monitor_delete_issue_comment`,
`monitor_list_issue_links`, `monitor_link_issue_pr`, `monitor_unlink_issue_pr`.

Service repositories: `monitor_list_service_repos`, `monitor_set_service_repo`,
`monitor_delete_service_repo`.

**Four things to get right in this block, all verified against the handlers:**

- **`status` ∈ unresolved | in_progress | resolved | ignored.** `in_progress` was added
  2026-08-25; a tool schema still listing three values rejects it client-side while the API
  accepts it, which is how this server briefly drifted from monitor-core. `unresolved` is
  also the backlog — there is no separate `backlog` value.
- **`status` is OPTIONAL on `monitor_update_issue`.** It used to be required, back when it
  was the only mutable field. Priority, title and assignee are now settable too.
- **Clearing a field needs an explicit JSON `null`.** The API distinguishes
  `{"priority": null}` (unset it) from an omitted key (leave it), which one optional
  parameter cannot express — hence the `clear_priority` / `clear_title` / `clear_assignee`
  flags, which map onto nulls in the request body.
- **`dedupe_key` on `monitor_add_issue_comment` is what makes agent notes idempotent.**
  Without one, every call appends another comment; with one, an identical body is a no-op
  and a changed body edits in place. The tool description tells the model to pass it — that
  wording is load-bearing, not decoration.

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

## 6a. Tenancy — which project answers, and why no tool takes a `project`

Monitor is multi-tenant. A **zone** is one whole `monitor-core` install (its own
ClickHouse, its own URL, its own keys); a **project** is a tenant inside a zone, and is
the dimension every event is filed under. `Event.Project` is stamped **server-side** at
ingest from the `api_keys` row behind the presented key and overwritten over whatever
the client sent.

**Do not add a `project` parameter to any tool. It would be an input the handler
silently ignores.**

The claim is checkable in `monitor-core/middleware/query_auth.go`. In
`QueryAuthMiddleware`, the DB admin-key branch resolves the tenant from that key's own
row — `scope.WithProject(ctx, identity.ProjectSlug)` — and ignores any `?project` on the
request. Its comment states the rule: an admin key reads **only** its own project,
because "admin" is a scope over VERBS (query vs. ingest) and never over tenants, and a
request-supplied slug must never be able to move a real boundary. A `project` sent from
here never reaches that decision at all; it lands as an ordinary filter column ANDed onto
the mandatory predicate, so it can only narrow a result, never widen one. The model would
pass `atlas`, the server would answer for the key's own project, and nothing on either
side would say so — the exact failure mode §5 names as the source of every bug shipped
across the five MCP servers.

**To read another project, add a second `~/.mcp.json` entry** whose `MONITOR_API_KEY` is
a key bound to that project (`monitor-atlas` alongside `monitor`). Keys are created per
project — `POST /v1/api-keys` takes an optional `project_slug`, defaulting to the install
default. This is the same asymmetry that already makes zones free: a zone is a separate
install with its own URL, so it is a separate entry too.

`monitor-web` *does* offer a `?project` selector, and that is not a contradiction:
`withSessionProject` in the same file resolves it for **sessions**, which have no
credential-side tenant to derive from. An API key does. (That selector is also explicitly
*not* a boundary — Monitor has no per-user membership table — which the middleware's
"project asymmetry" register spells out.)

### The `_scope` echo

Because the scope is invisible from the outside, `api()` annotates project-scoped
responses with the project that produced them:

```json
"_scope": { "project": "default", "zone": "trailblaze", "note": "results are limited to this project; …" }
```

- **Where:** in `withProjectScope()`, called from `api()` — the same chokepoint
  `sanitise()` uses, so a newly added tool is labelled by default rather than by
  remembering. The leading underscore marks it as this server's annotation, not a
  `monitor-core` field.
- **What is exempt:** anything not under `/v1/`, plus the `/v1` surfaces that are global
  configuration rather than tenant data — `SCOPE_ECHO_EXEMPT` in `index.js` lists them
  with the reason: `zones`/`projects` (registry), `service-repos` (one mapping serves
  every project), `alert-rules` (the rule rows), `notification-channels`, `alert-history`,
  and `dashboards`/`views`. Labelling one of those would assert a filter that is not
  there. It is a **denylist**, so a new tool is labelled by default; if you add one for a
  global-config route, add its path. The test is whether the handler's chain in
  `monitor-core` reaches `scope.ProjectPredicate`, `scopeIssues` or `apikeys.List`.
- **`POST /v1/alert-rules/{id}/test` is NOT exempt**, which is why the alert-rules pattern
  stops at one path segment. The rule row is global, but testing one *evaluates* it, and
  `alerts/evaluator.go:335` scopes that read — so the value returned is this project's.
- **How it is resolved:** one `GET /v1/api-keys`. That is not an inference —
  `apikeys.List` filters the listing by the project `QueryAuthMiddleware` resolved for the
  request, so the `project_slug` read back **is** the server's own answer to "whose data
  am I reading?". An API key has no `/self` and `monitor-core` sets no project header, so
  nothing echoes it more directly. `GET /v1/zones` runs alongside it and supplies `zone`
  only when the install has exactly one.
- **Cached for the process lifetime, including on failure.** Resolving per call would
  double every tool's request count; retrying after a failure would do that forever on an
  install where the label simply cannot be read.
- **Degrades, never breaks.** An unresolved scope becomes
  `{"project": null, "note": "answering project could not be resolved (…)"}` and the tool
  still returns its answer. Verified by running with a deliberately invalid key: the tool
  returned the API's 401 body plus the note, and nothing threw.

---

## 7. Coverage gaps (routes with no tool)

Per the house rule, these `monitor-core` routes have **no MCP tool** — decide add-or-skip:

| Route(s) | Assessment |
|---|---|
| `GET /v1/service-repos/{service}` | **Consciously skipped.** `monitor_list_service_repos` returns every mapping in one call and the estate has ~15 services, so a single-service fetch would be a second round trip for a subset of what the model already has. |
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

⚠️ **That exemption applies only BELOW the response envelope, and the `depth` parameter on
`sanitise()` is what enforces it — do not remove it.** `data` names two different things:
`monitor-core`'s responder wraps *every* payload as `{success, message, data, pagination}`, so the
**root** `data` is the whole response body, while a `data` *inside a row* is the free-form event
payload. Skipping both alike made the exemption swallow the entire response — nothing was masked
against a real `monitor-core`, and `monitor_create_api_key` returned its live admin key in full,
straight past the mask above. Hence `OPAQUE_FIELDS.has(k) && depth > 0`, and hence the array branch
maps through a lambda rather than `map(sanitise)`, which would pass the array index as `depth`.
Verify with the two cases together: a created key must come back `mo**********`, and an event's
`data` payload must come back untouched.

`MONITOR_ALLOW_SECRET_VALUES=1` disables masking. It is off by default and should stay that way.

---

## 9. Rules & guardrails + known issues

**Rules**
- Read the `monitor-core` handler before adding/changing a tool (§5).
- Keep `query_filters`/`notification_channel_ids` as JSON strings.
- `server.version` is read from `package.json` at startup — bump only `package.json`.
- Any new `monitor-core` route → add or consciously skip a tool here.
- **Never add a `project` parameter to a tool** (§6a). `monitor-core`'s
  `middleware/query_auth.go` derives the project from the `api_keys` row behind
  `MONITOR_API_KEY` and ignores a request-supplied one, so the parameter would be
  silently ignored. Reaching another project is a second `~/.mcp.json` entry with a key
  bound to it.
- **Keep the `_scope` echo central and non-fatal** (§6a) — resolved once in
  `withProjectScope()`/`api()`, cached for the process lifetime, and degrading to a note
  rather than an error when it cannot be resolved.
- **Never weaken `sanitise()`** (§8a) — it must stay recursive, applied centrally in `api()`, and
  on by default. If something genuinely needs a real value, the answer is
  `MONITOR_ALLOW_SECRET_VALUES=1` in that server's env, not an exemption in the code. In
  particular, **keep the `depth` parameter**: without it the `data` exemption matches the
  responder envelope and silently disables masking for every route.

**Known issues & gaps** — all resolved in the 2026-07-23 fix pass (kept here for traceability):

| ID | Sev | Where | Status |
|---|---|---|---|
| C1 | 🔴 | `monitor_update_alert_rule` | ✅ **Fixed.** The handler now strips all `undefined` params and only sends fields the caller provided — omitting `enabled` no longer sends `false`. Belt-and-suspenders with the monitor-core fix making PUT preserve `enabled` when omitted. Description updated to state omitted fields are left unchanged. |
| G1 | 🟡 | notification channels | ✅ **Fixed.** Added `monitor_list_notification_channels` (GET), `monitor_create_notification_channel` (POST — `name`, `type`, `config` JSON string), `monitor_delete_notification_channel` (DELETE). Shapes verified against `routes/alerts.go` + `alerts.Channel`/`CreateChannel`. |
| C2 | 🟢 | `api()` | ✅ **Fixed.** `api()` now checks `res.ok`, reads the body as text, JSON-parses when possible, and on non-ok returns an object carrying `http_status` and the body (parsed or raw). |
| C3 | 🟢 | `api()` URL build | ✅ **Fixed.** URL is now `API_URL` (trailing slash stripped) + leading-slash path, so a base like `https://host/basepath` is preserved. |
| C4 | 🟢 | `server.version` | ✅ **Fixed.** `server.version` reads from `package.json` at startup, so bumping only `package.json` is correct and the two cannot drift. |
| C5 | 🟢 | `monitor_get_issue_events` | ✅ **Fixed.** `limit` description now reads "default 50, max 500" to match the handler. |

---

## 10. Verification

There is no build step and no automated test suite, so verification is three things:

```bash
node --check index.js                 # must pass
grep -c 'server.tool(' index.js       # must match the count in §6 (55)
```

…plus a **manual end-to-end smoke test** against a running `monitor-core` with a valid
**admin-scope** key: drive `index.js` over stdio (`initialize`, `notifications/initialized`,
`tools/list`, then `tools/call`) and exercise the tool you changed. When adding a tool,
verify the request against the real handler (§5) first — reading the handler is what
catches the parameters the API ignores, and the smoke test is what catches the rest.

Last verified 2026-09-07 against `https://api.monitor.appleby.cloud`: 55 tools listed;
`monitor_list_zones` → one active zone (`trailblaze`); `monitor_list_projects` →
`{"projects": [default], "default_project_slug": "default"}`; `limit=9999` refused with
`400 limit must be between 1 and 500` (proving the route refuses rather than clamps);
`monitor_list_services`, `monitor_list_issues` and `monitor_list_api_keys` carried
`_scope {project: "default", zone: "trailblaze"}`; `monitor_health`, the two registry
tools, `monitor_list_service_repos` and `monitor_list_alert_rules` carried none. Re-run
with a deliberately invalid key: every tool still answered, with
`_scope {project: null, note: "…GET /v1/api-keys: HTTP 401…"}`.

---

## 11. Keeping this file updated

Any change to the tool set, a tool's request shape, auth, or config MUST update this file
in the same change. When a §9 finding is fixed, delete its row. When a `monitor-core`
route is added, update §6/§7 here.
