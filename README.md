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
| `monitor_health` | API health and queue stats (enqueued, dropped, pending) |
| `monitor_list_services` | List all services sending events |
| `monitor_list_environments` | List all environments (prod, staging, dev) |
| `monitor_list_event_names` | List event names, optionally filtered by service |
| `monitor_list_levels` | List log levels in use |
| `monitor_list_users` | List user IDs that have generated events |

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
| `monitor_set_service_repo` | Map a service to `owner/repo` |
| `monitor_delete_service_repo` | Remove a mapping |

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
