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

## Example Prompts

- "What errors happened in the last hour?"
- "Show me the error trend for forta-api today"
- "Trace request abc-123 across services"
- "Compare error rates this week vs last week"
- "Give me an overview of the johnnies-api service"
- "What are the top 10 most common errors?"
- "Find all events where data.status_code >= 500"

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONITOR_API_URL` | Yes | Monitor API base URL |
| `MONITOR_API_KEY` | Yes | API key for authentication (via `X-Api-Key` header) |

## License

MIT
