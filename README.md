# monitor-mcp

MCP server for the [Monitor](https://github.com/aidenappl/monitor-core) observability platform. Gives Claude Code direct access to query events, analyze errors, trace requests, and diagnose issues across services.

## Quick Start

```bash
npx monitor-mcp --setup
```

This prompts for your Monitor API URL and API key, writes the config to `~/.mcp.json`, and you're ready to go. Restart Claude Code after setup.

Generate an API key from the Monitor web dashboard under **Settings > API Keys**.

## Manual Setup

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "monitor": {
      "command": "npx",
      "args": ["-y", "monitor-mcp"],
      "env": {
        "MONITOR_API_URL": "https://api.monitor.appleby.cloud",
        "MONITOR_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools

### Discovery
| Tool | Description |
|------|-------------|
| `monitor_health` | API health and queue stats (enqueued, dropped, pending), plus `zone` and `role` — the answering process's own identity |
| `monitor_list_services` | List all services sending events |
| `monitor_list_environments` | List all environments (prod, staging, dev) |
| `monitor_list_event_names` | List event names, optionally filtered by service |
| `monitor_list_levels` | List log levels in use |
| `monitor_list_users` | List user IDs that have generated events |

### Zones & Projects
| Tool | Description |
|------|-------------|
| `monitor_list_zones` | The zones the answering process knows about — a zone is one whole Monitor deployment |
| `monitor_list_projects` | The projects (tenants) inside one zone, plus the install's default |

Both are read-only, and `monitor_list_projects` returns an object —
`{"projects": [...], "default_project_slug": "..."}` — not a bare array.

**`monitor_list_zones` does not tell you which zone you are talking to.** It reads the
registry table in the answering process's own database, so pointed at the control plane it
returns the whole fleet and pointed at a zone it returns just that zone's row — and nothing
in the response says which of the two happened. For your own zone, read `_scope.zone` on
any project-scoped answer, or call `monitor_health`. See
[Which zone and project you are reading](#which-zone-and-project-you-are-reading).

### Event Search
| Tool | Description |
|------|-------------|
| `monitor_search_events` | Search events with Django-style filters (`field__operator=value`) |
| `monitor_trace` | Get all events for a trace ID across services |
| `monitor_request` | Get all events for a request ID |

### Data Fields
| Tool | Description |
|------|-------------|
| `monitor_get_data_keys` | List custom data field keys in events |
| `monitor_get_data_values` | List distinct values for a data field |

### Analytics
| Tool | Description |
|------|-------------|
| `monitor_count` | Count events matching filters |
| `monitor_analytics` | Aggregation query with grouping (count, sum, avg, p99, etc.) |
| `monitor_timeseries` | Time-bucketed trend data (minute/hour/day/week/month) |
| `monitor_topn` | Top N values by field |
| `monitor_compare` | Period-over-period comparison with change percentage |

### Quick Diagnostics
| Tool | Description |
|------|-------------|
| `monitor_recent_errors` | Most recent error and fatal events |
| `monitor_error_breakdown` | Error frequency grouped by name, service, or endpoint |
| `monitor_error_trend` | Error count over time (is it getting worse?) |
| `monitor_service_overview` | Composite health summary — total events, error count, error rate, top events, top errors |

### Issue Tracking
Errors grouped by fingerprint into trackable issues, with triage state, a comment
thread, linked pull requests and durable occurrence history.

| Tool | Description |
|------|-------------|
| `monitor_list_issues` | List issues, filtered by status, service, assignee, `has_pr`, search or time window |
| `monitor_get_issue` | Full detail — links, assignee, repository, comment count, 30-day sparkline |
| `monitor_update_issue` | Set status, priority, title or assignee. Every change is recorded on the timeline against you |
| `monitor_get_issue_events` | Individual occurrences with their data payloads (raw events expire after 30 days) |
| `monitor_get_issue_timeline` | The activity feed — comments, status changes, regressions, PR events |
| `monitor_get_issue_history` | Per-day occurrence counts. Survives the 30-day event expiry |
| `monitor_add_issue_comment` | Leave a note while working an issue. Pass `dedupe_key` to stay idempotent |
| `monitor_edit_issue_comment` / `monitor_delete_issue_comment` | Amend or soft-delete a note |
| `monitor_list_issue_links` / `monitor_link_issue_pr` / `monitor_unlink_issue_pr` | Manage linked PRs, issues and commits |

**Status** is `unresolved` (also the backlog), `in_progress`, `resolved` or `ignored`.
An error recurring on a `resolved` issue reopens it as a regression; one recurring on an
`in_progress` issue leaves it alone, so picking work up is never undone by the error
happening again.

**Leaving notes idempotently.** `monitor_add_issue_comment` appends a comment on every
call unless you pass a `dedupe_key`. With one, reposting the same body is a no-op and a
changed body edits the note in place — which is what lets a retried task, or the same
investigation resumed in a later session, avoid leaving five copies of one note.

### Service Repositories
| Tool | Description |
|------|-------------|
| `monitor_list_service_repos` | Which source repository each reporting service is built from |
| `monitor_set_service_repo` | Map a service to `owner/repo` — takes a required `zone` |
| `monitor_delete_service_repo` | Remove a mapping — takes a required `zone` |

Several services routinely share one repository — `auth-service-v1` and `auth-service-v2`
are versions of one service — so the mapping is explicit rather than derived from the
service name. Mapping a service is what lets `monitor_link_issue_pr` accept a bare `#42`.

## Example Prompts

- "What errors happened in the last hour?"
- "Show me the error trend for forta-api today"
- "Trace request abc-123 across services"
- "Compare error rates this week vs last week"
- "Give me an overview of the johnnies-api service"
- "What are the top 10 most common errors?"
- "Find all events where data.status_code >= 500"
- "Show me unresolved issues for scraper-service with no linked PR"
- "Mark issue X as in progress and note that I'm investigating the Workday timeout"
- "When did this issue first start firing, and how often does it recur?"
- "Which project am I reading, and what other projects exist in this zone?"

## Filter Syntax

Event search supports Django-style filter operators:

| Operator | Example | Description |
|----------|---------|-------------|
| `eq` (default) | `service=my-api` | Exact match |
| `neq` | `level__neq=info` | Not equal |
| `contains` | `name__contains=error` | Substring match |
| `startswith` | `name__startswith=http` | Prefix match |
| `gt`, `gte`, `lt`, `lte` | `data.status_code__gte=400` | Numeric comparison |
| `in` | `level__in=error,fatal` | Match any value |

Data fields use the `data.` prefix: `data.endpoint__contains=/api`, `data.status_code__gte=500`.

## Which zone and project you are reading

Monitor is multi-tenant. A **zone** is one whole Monitor deployment — its own process, its
own storage, its own URL, its own API keys — and a **project** is a tenant inside a zone.
Every event is filed under a project, stamped server-side from the API key that sent it.

One server here speaks to exactly **one zone and one project**: the zone is whatever
`MONITOR_API_URL` points at, and the project is whatever `MONITOR_API_KEY` is bound to.

**Your API key decides which project you read, and nothing in a request can change it.**
An admin key reads only the project its own key record names; "admin" is a scope over
what you may do (query vs. ingest), not over whose data you may see. That is why no tool
here takes a `project` argument — it would be an argument the server ignores.

So every project-scoped answer carries a `_scope` annotation naming the zone, the project
and the URL that produced it:

```json
{
  "success": true,
  "data": [ … ],
  "_scope": {
    "zone": "trailblaze",
    "role": "both",
    "project": "default",
    "api_url": "https://api.monitor.appleby.cloud",
    "note": "events, issues and analytics answers are limited to this project …"
  }
}
```

- **`zone` and `role` come from `GET /health`**, where Monitor publishes the answering
  process's own identity. That is the only authoritative source: the zone *registry*
  (`monitor_list_zones`) lists the zones an install knows about, which says nothing about
  which one is answering.
- **`project` comes from `GET /v1/api-keys`**, whose listing the server filters to the
  project it resolved for the request — so the slug read back is its own answer to "whose
  data am I reading?".
- **`api_url` is the configured `MONITOR_API_URL`**, echoed so the three facts — which
  zone, which project, which URL — are all in one place.

It is resolved once and reused for about five minutes (thirty seconds if it could not be
resolved), so it costs a request every few minutes rather than one per call, and a server
left running for days still reports the fleet as it is now rather than as it was at boot.
Each half degrades on its own: an unresolved project is `null` with a note, an unresolved
zone is simply absent with a note. The answer always comes back; only the label goes
missing.

Responses that carry **no** `_scope` are the ones that are not per-project in the first
place: health, the zone/project registry, service→repo mappings, alert rules,
notification channels and alert history are install-wide configuration, shared by every
project.

**To read a second project, add a second entry** with a key bound to it:

```json
{
  "mcpServers": {
    "monitor": {
      "command": "npx",
      "args": ["-y", "monitor-mcp"],
      "env": { "MONITOR_API_URL": "https://api.monitor.appleby.cloud", "MONITOR_API_KEY": "key-for-default" }
    },
    "monitor-atlas": {
      "command": "npx",
      "args": ["-y", "monitor-mcp"],
      "env": { "MONITOR_API_URL": "https://api.monitor.appleby.cloud", "MONITOR_API_KEY": "key-for-atlas" }
    }
  }
}
```

Another **zone** works the same way, with its own `MONITOR_API_URL` as well as its own key.
Use `monitor_list_zones` and `monitor_list_projects` to see what exists.

## Writes name their zone, and it is checked

Reads are labelled after the fact. Writes cannot be, because a write cannot be undone —
so the tools that create or change something in a zone take a **required `zone`
argument**, and refuse the call when it does not match the zone this server actually talks
to.

| Tool | |
|------|--|
| `monitor_create_api_key` | binds a key to a project in the answering zone |
| `monitor_delete_api_key` | revokes a key in the answering zone — irreversible, and the producer's only symptom is a 401 |
| `monitor_create_alert_rule` / `monitor_update_alert_rule` / `monitor_delete_alert_rule` | rules live in the answering zone's database |
| `monitor_create_notification_channel` / `monitor_delete_notification_channel` | channels live in the answering zone's database |
| `monitor_set_service_repo` / `monitor_delete_service_repo` | mappings serve the answering zone only |
| `monitor_create_sso_provider` / `monitor_update_sso_provider` / `monitor_delete_sso_provider` | providers govern sign-in to the answering zone |

**The argument is verified, never routed.** It is not sent to Monitor and it cannot make a
request go anywhere; it is compared against `zone` from `GET /health` and the call is
refused, unsent, on a mismatch. Nothing here can reach another zone — that is a different
deployment behind a different URL.

It exists because Monitor binds a write to the zone of the process that answers it, and
says nothing about which zone that was. Ask a server pointed at the control plane for an
ingest key "for appleby" and, without this check, you get `200 OK` and a key bound to a
**trailblaze** project — and the service you wire it into reports into the wrong tenant
until somebody notices an empty dashboard weeks later. Naming the zone is what turns that
into an error message.

A refusal looks like this, and the request was never sent:

```json
{
  "success": false,
  "error": "zone_mismatch",
  "error_message": "refused: this MCP server talks to zone \"trailblaze\" …, not \"appleby\". The write was NOT sent.",
  "requested_zone": "appleby",
  "actual_zone": "trailblaze",
  "what_to_do": "Use the ~/.mcp.json entry configured for zone \"appleby\" …"
}
```

If the server cannot read its own zone at all — an unreachable `/health`, or a Monitor
predating multi-zone — these writes refuse too (`zone_unverifiable`) rather than guess.
Reads are unaffected; they just lose the `zone` half of their label.

Get the value from `monitor_health` or from `_scope.zone` on any read. Do **not** take it
from `monitor_list_zones`, which lists the zones an install knows about, not the one it is.

## Secret values are masked

Every response is passed through a masking step before it reaches the model. Anything that looks
like a credential keeps its **first two characters** and loses the rest to a fixed-width tail —
`supersecret` becomes `su**********`.

That is enough to tell two credentials apart, or to confirm a rotation actually changed
something, and not enough to use. The tail is a fixed width so the mask does not reveal the real
length.

The main thing this covers is `monitor_create_api_key`, which returns a full admin or ingest key
once — enough to read every event the platform holds. `key_prefix` is left readable, since it is
a non-secret identifier for matching a key to its record.

Event payloads (`data`, `context`, `extra`, `tags`) are **not** masked. They are free-form and
come from your instrumented services; if a service logs a secret into an event, it will still
show up here, and the fix belongs in that service.

Set `MONITOR_ALLOW_SECRET_VALUES=1` to turn masking off if you genuinely need a working value.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONITOR_API_URL` | Yes | Monitor API base URL |
| `MONITOR_API_KEY` | Yes | API key for authentication (via `X-Api-Key` header) |
| `MONITOR_ALLOW_SECRET_VALUES` | No | Set to `1` to disable secret masking in responses |

## License

MIT
