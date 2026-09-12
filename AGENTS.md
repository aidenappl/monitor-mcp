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

- Node ESM, single file `index.js` (~1785 lines).
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
- **Zone is the opposite case.** Every zone-binding WRITE tool takes a **required `zone`**,
  which is **verified and never forwarded** — `requireZone()` compares it with `zone` from
  `GET /health` and refuses the call, unsent, on a mismatch. This is not a contradiction of
  the rule above: `project` would be an input nothing reads, `zone` is an assertion this
  server checks itself. Full reasoning in **§6b** — read it before removing the parameter.

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
- **Neither route identifies the process serving it.** Both read the registry table in the
  ANSWERING process's own MariaDB, so the control plane returns the whole fleet and a zone
  returns its own row, in an identical response shape. `monitor_list_zones`' description
  therefore points the reader at `_scope.zone` / `monitor_health` instead — keep that
  wording. Counting rows here is exactly the bug §6a describes.

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

**Twelve of the tools above take a required, verified `zone`** — `monitor_create_api_key`
and `monitor_delete_api_key`, the three alert-rule mutations, the two notification-channel
mutations, the two service-repo mutations and the three SSO-provider mutations. It is
checked against `GET /health` and never forwarded; see **§6b** before adding, removing or
copying it.

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
responses with the zone, project and URL that produced them:

```json
"_scope": {
  "zone": "trailblaze",
  "role": "both",
  "project": "default",
  "api_url": "https://api.monitor.appleby.cloud",
  "note": "events, issues and analytics answers are limited to this project; …"
}
```

Three facts, deliberately: **which zone answered, whose data it answered with, and where
to look.** No single monitor-core response field carries all three.

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
- **How `project` is resolved:** one `GET /v1/api-keys`. That is not an inference —
  `apikeys.List` filters the listing by the project `QueryAuthMiddleware` resolved for the
  request, so the `project_slug` read back **is** the server's own answer to "whose data
  am I reading?". An API key has no `/self` and `monitor-core` sets no project header, so
  nothing echoes it more directly.
- **How `zone` and `role` are resolved: one `GET /health`, and it must stay that way.**
  `/health` reports `zone` (from `env.ZoneSlug`) and `role` as the **answering process's
  own identity** — unauthenticated, and put there for exactly this purpose; the handler
  comment in `routes/events.go` says it exists so a caller can tell "a monitor-core
  answered" from "the monitor-core I meant answered", and `probe.Zone` compares registry
  rows against it. It is correct whether the URL points at the control plane or at a zone.
  ⚠️ **This previously read `GET /v1/zones` and used the slug only when the listing had
  exactly ONE row.** That is a registry LISTING, not an identity: the moment a second zone
  was registered the count stopped being one and `zone` silently disappeared from every
  `_scope` — at precisely the moment multi-zone made it load-bearing. A fleet-wide
  registry can never identify the process serving it. Do not go back.
- **`api_url` is the configured `MONITOR_API_URL`,** echoed verbatim. It costs nothing and
  closes the last ambiguity about which deployment produced an answer.
- **Cached with a TTL, including on failure** — `SCOPE_TTL_MS` (5 min) on a fully-resolved
  scope, `SCOPE_FAILURE_TTL_MS` (30 s) otherwise. Resolving per call would double every
  tool's request count, and retrying immediately after a failure would do that forever on
  an install where the label cannot be read — but the earlier "cache forever" made a
  long-running server report the fleet it *booted into*: a process started when there was
  one zone kept answering from that snapshot for days, uncorrectable short of a restart.
  The short TTL is stamped **before** the request and extended only once a complete answer
  returns, so a rejected, hanging or partial resolve expires quickly. `Date.now()` is read
  at call time only — never inside a module-level constant, which would freeze the clock at
  import.
- **Degrades per half, never breaks.** An unresolved project is `{"project": null, …}`;
  an unresolved zone is simply absent. Each adds its own sentence to `note` and the tool
  still returns its answer. Verified against a stub returning `500` on `/health`: the read
  carried `project` plus a note naming the gap, nothing threw, and the label healed by
  itself 30 s later once the stub recovered.

---

## 6b. Zone verification on writes — why `zone` is a parameter and `project` is not

**§6a is about `project`. None of it transfers to `zone`, and reading it as though it did
is how someone deletes a parameter that is load-bearing.**

A project is chosen by a **credential inside one process**: the slug never reaches a
decision, so a parameter for it is a parameter the handler ignores. A zone is a **whole
separate process** — own binary, own ClickHouse, own MariaDB, own URL — so which zone
answers is settled by `MONITOR_API_URL` before a request is sent. That makes the zone
*checkable*, and on writes it makes checking it *necessary*.

**The failure it prevents.** `monitor-core`'s `apikeys.resolveProject` (`apikeys/apikeys.go`)
resolves the zone from `env.ZoneSlug` — the **answering** process's own env — and looks the
project up in that zone. Point this server at the control plane, ask for an ingest key "for
appleby", and you get `200 OK` with a key bound to a **trailblaze** project. The service
wired to it then reports into the wrong tenant, permanently, with nothing on either side
saying so. Every other write here has the same shape: alert rules, notification channels,
service→repo mappings and SSO providers are rows in the answering zone's own MariaDB and
none of them names a zone in its body.

**The mechanism.** `requireZone(zone)` resolves the actual zone through the `§6a` memo (so
the check costs nothing per call) and:

- returns `null` when they match — call sites read `const refusal = await requireZone(zone);
  if (refusal) return refusal;`
- returns a finished **`isError`** tool result on a mismatch (`error: "zone_mismatch"`),
  naming the requested zone, the actual zone, the URL, and what to do instead. A refusal
  rather than a thrown exception because the model must be able to read *why*.
- **fails closed** when the zone cannot be read at all (`error: "zone_unverifiable"`).
  The asymmetry with the `_scope` label is deliberate: a missing label costs a re-read, an
  unverified write is the exact failure this exists to prevent and it cannot be undone. The
  30 s failure TTL bounds a transient `/health` outage to a brief block, not a dead server.

**It is VERIFIED, NEVER ROUTED.** `zone` is destructured out before any body is built, is
never put in a body or query string, and cannot make a request go anywhere. That is the
whole difference from `project` in one line: `project` would be an input nothing reads,
`zone` is an assertion this server checks itself.

**Which tools take it** (12) — everything that creates or changes a row in a zone:

| Tool(s) | Binds |
|---|---|
| `monitor_create_api_key` | a key to a project in the answering zone |
| `monitor_delete_api_key` | revokes a key **in the answering zone** — the destructive one; see below |
| `monitor_create_alert_rule`, `monitor_update_alert_rule`, `monitor_delete_alert_rule` | rule rows in the answering zone's MariaDB |
| `monitor_create_notification_channel`, `monitor_delete_notification_channel` | channel rows, same |
| `monitor_set_service_repo`, `monitor_delete_service_repo` | the service→repo mapping for that zone only |
| `monitor_create_sso_provider`, `monitor_update_sso_provider`, `monitor_delete_sso_provider` | who may sign in to that zone |

**Reads do NOT take it** and must not gain it — they carry `_scope` instead, and a
required argument on 43 read tools would be cost without safety. `monitor_list_projects`'s
`zone` is unrelated: that one is a genuine path segment the route needs.

**`monitor_delete_api_key` is guarded even though the argument for skipping it is sound.**
Key IDs are UUIDs, so an ID copied from another zone's listing all but certainly 404s
rather than revoking a live key, and in practice the ID comes from `monitor_list_api_keys`
on this same connection. It is guarded anyway, and the reasons are worth keeping written
down: it is the one **destructive** verb in the set — revoking an ingest key stops a
tenant's services reporting, and the only symptom is a 401 at the producer with nothing in
Monitor to explain it — and "almost certainly 404s" is a probability argument guarding an
irreversible action. The second reason is **consistency as a safety property in itself**: a
`create_api_key` that requires a zone beside a `delete_api_key` that does not reads as
"deletes are zone-safe by construction", when they would only ever have been zone-safe by
UUID collision odds.

Not covered: the issue-mutation tools (project-scoped rather than zone-binding, and their
IDs come from a listing on this same connection), and `/v1/dashboards`, `/v1/views` and
`/v1/notification-channels/{id}/test`, which have no write tool today — **give any future
one a `zone`.**

One shared `ZONE_PARAM_DESC` constant supplies the parameter description so twelve copies
cannot drift.

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
- **Keep the `_scope` echo central and non-fatal** (§6a) — resolved in
  `withProjectScope()`/`api()`, cached with a TTL (never forever), and degrading to a note
  rather than an error when it cannot be resolved.
- **Take `zone` from `GET /health`, never by counting `GET /v1/zones` rows** (§6a). The
  registry is a listing; `/health` is the answering process's identity. The row-counting
  version silently dropped `zone` from every response the day a second zone was registered.
- **Never remove the `zone` parameter from a zone-binding write** (§6b), and never
  "simplify" it by forwarding it to monitor-core. It is verified, not routed. Any new write
  tool for a zone-scoped resource gets one; any new read tool does not.
- **Never weaken `sanitise()`** (§8a) — it must stay recursive, applied centrally in `api()`, and
  on by default. If something genuinely needs a real value, the answer is
  `MONITOR_ALLOW_SECRET_VALUES=1` in that server's env, not an exemption in the code. In
  particular, **keep the `depth` parameter**: without it the `data` exemption matches the
  responder envelope and silently disables masking for every route.

**Known issues & gaps**

Open — both are documentation hygiene in **this file**, both were left untouched by the
2026-09-08 pass on purpose (to keep that diff to zone safety), and both are recorded here
so they are corrected rather than rediscovered:

| ID | Sev | Where | Status |
|---|---|---|---|
| D1 | 🟢 | `AGENTS.md` §7 table | **Open — do not fix in a code change; fix as docs.** The `POST /v1/notification-channels/{id}/test` row writes the three tool names as one backticked alternation containing `\|` characters. GFM reads those as column separators regardless of the backticks, so the row renders with extra, empty columns. Pre-existing (it predates the zone pass). The fix is to spell the three names out comma-separated, as §6b's table does. Same trap applies to §6's prose alternations — those are safe only because they are not inside a table. |
| D2 | 🟢 | `AGENTS.md` §3 | **Open — cosmetic.** Cites `index.js:54-58` for the "exits if `MONITOR_API_URL`/`MONITOR_API_KEY` is missing" guard. It sits at 65-69 and was already stale before the zone pass. Line-number citations into a 1800-line file drift on every edit — either re-anchor it to a symbol (`the API_URL/API_KEY guard near the top`) or drop the numbers. Worth a sweep: §5 and §6a carry similar `file:line` references into `monitor-core`. |

Resolved in the 2026-09-08 zone-safety pass:

| ID | Sev | Where | Status |
|---|---|---|---|
| Z1 | 🟡 | `monitor_delete_api_key` | ✅ **Fixed.** Initially left unguarded on the grounds that key IDs are UUIDs (a cross-zone ID 404s rather than revoking a live key). Guarded anyway: it is the one **destructive** verb in the set — revoking an ingest key silently stops a tenant reporting, visible only as a 401 at the producer — so a probability argument was guarding an irreversible action; and the inconsistency was itself a hazard, since `create_api_key` requiring a zone while `delete_api_key` did not reads as "deletes are zone-safe by construction". Reasoning kept in §6b. |
| Z2 | 🟢 | `SCOPE_ECHO_EXEMPT` comment | ✅ **Fixed.** The comment above the zones/projects tools claimed those two are "the only /v1 tools whose responses carry no `_scope`"; there are six exempt patterns (zones/projects, service-repos, notification-channels, alert-history, alert-rules, dashboards/views). Reworded to state the real point — that a registry does not identify the process serving it. §6a's list stays the authority. |
| Z3 | 🔴 | `resolveProjectScope()` | ✅ **Fixed.** `zone` was taken from `GET /v1/zones` only when the listing had exactly one row, so registering a second zone silently removed `_scope.zone` from every response. Now read from `GET /health`, which reports the answering process's own zone (and `role`). |
| Z4 | 🟡 | `projectScope()` memo | ✅ **Fixed.** `if (!scopePromise)` cached the scope for the process lifetime, so a long-running server reported the fleet it booted into — one confirmed live server was still answering with a one-zone snapshot. Now 5 min on success / 30 s on failure. |
| Z5 | 🔴 | `monitor_create_api_key` + 11 other writes | ✅ **Fixed.** `apikeys.resolveProject` binds a new key to the ANSWERING process's zone, so a key requested "for appleby" against the control plane came back bound to a trailblaze project, 200 OK, silently. All twelve zone-binding writes now take a required `zone`, verified against `/health` and refused on mismatch (§6b). |

Resolved in the 2026-07-23 fix pass (kept for traceability):

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

Last verified **2026-09-08** against `https://api.monitor.appleby.cloud` (the control plane,
`role: both`, zone `trailblaze`): 55 tools listed, every `inputSchema` a valid object.

- `monitor_health` → `{status: ok, role: "both", zone: "trailblaze", clickhouse_ok, mariadb_ok, alerting_ok}`.
- `monitor_list_zones` → **TWO** active zones (`trailblaze`, `appleby`) — the fleet registry,
  because this URL is the control plane. It is not the answer to "which zone am I on".
- `monitor_list_services` → `_scope {zone: "trailblaze", role: "both", project: "default",
  api_url: "https://api.monitor.appleby.cloud", note: …}`. `monitor_list_zones` carried none.
- All 12 zone-binding writes list `zone` in their schema's `required`; all 43 other tools
  are unchanged (`monitor_list_projects` keeps its unrelated path-segment `zone`).
- `monitor_create_api_key {zone: "appleby"}`, `monitor_delete_api_key {zone: "appleby"}` and
  `monitor_delete_sso_provider {zone: "does-not-exist"}` → all refused, `isError`,
  `zone_mismatch`, naming both zones — **and no request was sent** in any of the three.
  `monitor_update_alert_rule {zone: "trailblaze",
  id: <all-zeros>}` → passed the guard and reached the API (`400 alert rule not found`),
  proving the guard forwards rather than blocks on a match, and mutating nothing.

TTL and degradation verified against a local stub (no production traffic): with `/health`
returning 500, three tool calls made **one** probe and the read carried
`project` + a note naming the gap; the write refused with `zone_unverifiable` (fail-closed);
31 s later the next call re-probed, the stub recovered and `_scope` healed to a full label;
two further calls made zero extra probes (the 5-minute success TTL).

---

## 11. Keeping this file updated

Any change to the tool set, a tool's request shape, auth, or config MUST update this file
in the same change. When a §9 finding is fixed, delete its row. When a `monitor-core`
route is added, update §6/§7 here.
