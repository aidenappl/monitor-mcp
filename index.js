#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createInterface } from "readline";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

// --- Interactive setup ---

if (process.argv.includes("--setup")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

    console.log("\n  Monitor MCP Setup\n");

    const apiUrl = (await ask("  Monitor API URL (https://api.monitor.appleby.cloud): ")).trim() || "https://api.monitor.appleby.cloud";
    const apiKey = (await ask("  Monitor API Key: ")).trim();
    rl.close();

    if (!apiKey) {
        console.error("\n  Error: API key is required.\n");
        process.exit(1);
    }

    const mcpPath = join(homedir(), ".mcp.json");
    let config = { mcpServers: {} };
    if (existsSync(mcpPath)) {
        try { config = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch {}
        if (!config.mcpServers) config.mcpServers = {};
    }

    config.mcpServers.monitor = {
        command: "npx",
        args: ["-y", "monitor-mcp"],
        env: {
            MONITOR_API_URL: apiUrl,
            MONITOR_API_KEY: apiKey,
        },
    };

    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`\n  Written to ${mcpPath}`);
    console.log("  Restart Claude Code to load the Monitor MCP server.\n");
    process.exit(0);
}

// --- MCP Server ---

const API_URL = process.env.MONITOR_API_URL;
const API_KEY = process.env.MONITOR_API_KEY;
// Optional admin *session* token (a Monitor access JWT). The `/admin/sso-providers*`
// and `/auth/self*` routes sit behind monitor-core's SessionMiddleware, which accepts
// ONLY an `Authorization: Bearer <access-jwt>` (or the mon-access-token cookie) — it
// does NOT honour X-Api-Key. When this env var is set it is sent as a Bearer header so
// those session-gated tools can work; the X-Api-Key header is always sent too and is
// what every /v1/* (QueryAuthMiddleware) tool authenticates with.
const SESSION_TOKEN = process.env.MONITOR_SESSION_TOKEN;

if (!API_URL || !API_KEY) {
    console.error("MONITOR_API_URL and MONITOR_API_KEY are required.");
    console.error("Run `npx monitor-mcp --setup` to configure.");
    process.exit(1);
}

// --- API helper ---

async function api(method, path, params, body) {
    // Preserve any base path on API_URL (e.g. https://host/basepath) by
    // concatenating the trimmed base with the leading-slash path, rather than
    // using new URL(path, base) which discards the base's path for absolute paths.
    const base = API_URL.replace(/\/+$/, "");
    const url = new URL(base + (path.startsWith("/") ? path : "/" + path));
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
    }

    const opts = {
        method,
        headers: {
            "X-Api-Key": API_KEY,
        },
        signal: AbortSignal.timeout(30000),
    };

    // Session-gated routes (/admin/sso-providers*, /auth/self*) require a Bearer
    // access JWT; X-Api-Key alone yields 401 there. Harmless on /v1/* routes, which
    // check X-Api-Key first via QueryAuthMiddleware.
    if (SESSION_TOKEN) {
        opts.headers["Authorization"] = `Bearer ${SESSION_TOKEN}`;
    }

    if (body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }

    try {
        const res = await fetch(url.toString(), opts);
        const raw = await res.text();
        let parsed;
        try {
            parsed = raw ? JSON.parse(raw) : null;
        } catch {
            parsed = null;
        }

        if (!res.ok) {
            // Surface the HTTP status even when the body isn't JSON (e.g. a
            // proxy 401/403/500). Prefer the parsed error shape when present.
            if (parsed && typeof parsed === "object") {
                return { ...sanitise(parsed), success: false, http_status: res.status };
            }
            return {
                success: false,
                http_status: res.status,
                error: `HTTP ${res.status} ${res.statusText}`,
                error_message: raw || res.statusText,
            };
        }

        return sanitise(parsed);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function text(data) {
    return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}

// --- Sensitive value masking ---
//
// monitor-core keeps SSO client secrets write-only (reads expose only
// has_secret), but monitor_create_api_key returns a full admin or ingest key
// once, and that key is enough to read every event the platform holds.
// Anything that reaches a model's context is in a transcript forever.
//
// Sensitive values are masked to their first two characters plus a
// fixed-width tail: "mon_abc123" -> "mo**********". The prefix keeps a value
// identifiable and comparable while the fixed tail avoids disclosing length.
// Read the usable value from the Monitor UI instead.
//
// Note this does NOT reach into event `data` payloads. Those are free-form and
// come from instrumented services; if a service logs a secret into an event,
// it will still surface here. That is a bug in the emitting service, and the
// fix belongs there rather than in a guess about payload shape.
//
// Set MONITOR_ALLOW_SECRET_VALUES=1 to pass values through unmasked.

const ALLOW_SECRETS = process.env.MONITOR_ALLOW_SECRET_VALUES === "1";

function mask(value) {
    if (typeof value !== "string" || value === "") return value;
    // Under three characters there is no prefix worth keeping — a two-char
    // secret would otherwise round-trip as itself.
    if (value.length < 3) return "**********";
    return value.slice(0, 2) + "**********";
}

// Response fields that are a credential wherever they appear. `key_prefix` is
// deliberately absent: it is a non-secret identifier for matching a key to its
// record, and masking it would defeat the point of listing keys at all.
const SECRET_FIELDS = new Set([
    "key", "api_key", "token", "api_token", "access_token", "refresh_token",
    "client_secret", "secret", "password", "plaintext", "signing_key",
]);

// Event payloads are user-supplied and arbitrarily shaped; walking into them
// with a key-name heuristic produces noise without producing safety. They are
// left intact, as documented above.
const OPAQUE_FIELDS = new Set(["data", "context", "extra", "tags"]);

// Walks a decoded response and masks every sensitive value in place.
function sanitise(node) {
    if (ALLOW_SECRETS || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(sanitise);
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (OPAQUE_FIELDS.has(k)) {
            out[k] = v;
        } else if (SECRET_FIELDS.has(k) && typeof v === "string") {
            out[k] = mask(v);
        } else {
            out[k] = sanitise(v);
        }
    }
    return out;
}

// --- Server ---

const server = new McpServer({
    name: "monitor",
    version: pkg.version,
});

// ==================== HEALTH ====================

server.tool("monitor_health", "Check Monitor API health — returns queue stats (enqueued, dropped, pending events)", {}, async () => {
    const res = await api("GET", "/health");
    return { content: text(res) };
});

// ==================== SERVICE DISCOVERY ====================

server.tool(
    "monitor_list_services",
    "List all services sending events to Monitor. Use this first to discover what services are available before querying events.",
    {
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to all time."),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp). Defaults to now."),
    },
    async ({ from, to }) => {
        const res = await api("GET", "/v1/labels/service/values", { from, to });
        return { content: text(res) };
    }
);

server.tool(
    "monitor_list_environments",
    "List all environments (e.g. prod, staging, dev) that have sent events.",
    {
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp)"),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
    },
    async ({ from, to }) => {
        const res = await api("GET", "/v1/labels/env/values", { from, to });
        return { content: text(res) };
    }
);

server.tool(
    "monitor_list_event_names",
    "List all event names (e.g. http.request, db.query, user.login). Filter by service to see events for a specific service.",
    {
        service: z.string().optional().describe("Filter by service name"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp)"),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
    },
    async ({ service, from, to }) => {
        const params = { from, to };
        if (service) params.service = service;
        const res = await api("GET", "/v1/labels/name/values", params);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_list_levels",
    "List all log levels in use (e.g. info, warn, error, fatal).",
    {
        service: z.string().optional().describe("Filter by service name"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp)"),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
    },
    async ({ service, from, to }) => {
        const params = { from, to };
        if (service) params.service = service;
        const res = await api("GET", "/v1/labels/level/values", params);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_list_users",
    "List all user IDs that have generated events.",
    {
        service: z.string().optional().describe("Filter by service name"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp)"),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
    },
    async ({ service, from, to }) => {
        const params = { from, to };
        if (service) params.service = service;
        const res = await api("GET", "/v1/labels/user_id/values", params);
        return { content: text(res) };
    }
);

// ==================== DATA FIELD EXPLORATION ====================

server.tool(
    "monitor_get_data_keys",
    "List all custom data field keys present in events. Events can carry arbitrary JSON data — this shows what keys are available for filtering and analysis.",
    {
        service: z.string().optional().describe("Filter by service name"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp)"),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
    },
    async ({ service, from, to }) => {
        const params = { from, to };
        if (service) params.service = service;
        const res = await api("GET", "/v1/data/keys", params);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_get_data_values",
    "List distinct values for a specific data field key. Useful for understanding what values a field can have before filtering on it.",
    {
        key: z.string().describe("The data field key to get values for (e.g. 'status_code', 'endpoint', 'error')"),
        service: z.string().optional().describe("Filter by service name"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp)"),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
    },
    async ({ key, service, from, to }) => {
        const params = { key, from, to };
        if (service) params.service = service;
        const res = await api("GET", "/v1/data/values", params);
        return { content: text(res) };
    }
);

// ==================== EVENT SEARCH ====================

server.tool(
    "monitor_search_events",
    `Search and filter events. This is the primary diagnostic tool.

Filters use Django-style syntax: field__operator=value
Supported fields: service, env, name, level, job_id, request_id, trace_id, user_id
Data fields: prefix with "data." (e.g. data.status_code, data.endpoint)
Operators: eq (default), neq, lt, gt, lte, gte, contains, startswith, endswith, in

Examples:
- Find errors: level=error
- Find errors for a service: service=my-api, level=error
- Search by request ID: request_id=abc-123
- Filter by data field: use data_filters with key__operator=value`,
    {
        service: z.string().optional().describe("Filter by service name (exact match)"),
        env: z.string().optional().describe("Filter by environment (exact match)"),
        name: z.string().optional().describe("Filter by event name (exact match)"),
        level: z.string().optional().describe("Filter by log level: info, warn, error, fatal"),
        request_id: z.string().optional().describe("Filter by request ID (exact match)"),
        trace_id: z.string().optional().describe("Filter by trace ID (exact match)"),
        job_id: z.string().optional().describe("Filter by job ID (exact match)"),
        user_id: z.string().optional().describe("Filter by user ID (exact match)"),
        name__contains: z.string().optional().describe("Event name contains substring"),
        service__in: z.string().optional().describe("Comma-separated list of services"),
        level__in: z.string().optional().describe("Comma-separated list of levels (e.g. 'error,fatal')"),
        data_filters: z
            .array(z.string())
            .optional()
            .describe(
                'Data field filters as "key__operator=value" strings. Examples: "status_code__gte=400", "endpoint__contains=/api", "error__neq="'
            ),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to last 1 hour if not set."),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp). Defaults to now."),
        limit: z.number().optional().describe("Max events to return (1-1000, default 100)"),
        offset: z.number().optional().describe("Pagination offset"),
    },
    async ({ service, env, name, level, request_id, trace_id, job_id, user_id, name__contains, service__in, level__in, data_filters, from, to, limit, offset }) => {
        const params = {};

        // Simple field filters
        if (service) params.service = service;
        if (env) params.env = env;
        if (name) params.name = name;
        if (level) params.level = level;
        if (request_id) params.request_id = request_id;
        if (trace_id) params.trace_id = trace_id;
        if (job_id) params.job_id = job_id;
        if (user_id) params.user_id = user_id;

        // Operator-based filters
        if (name__contains) params["name__contains"] = name__contains;
        if (service__in) params["service__in"] = service__in;
        if (level__in) params["level__in"] = level__in;

        // Data field filters
        if (data_filters) {
            for (const filter of data_filters) {
                const eqIdx = filter.indexOf("=");
                if (eqIdx === -1) continue;
                const key = "data." + filter.substring(0, eqIdx);
                const value = filter.substring(eqIdx + 1);
                params[key] = value;
            }
        }

        // Time range — default to last 1 hour if no from specified
        if (from) {
            params.from = from;
        } else {
            params.from = new Date(Date.now() - 3600000).toISOString();
        }
        if (to) params.to = to;

        if (limit) params.limit = limit;
        if (offset) params.offset = offset;

        const res = await api("GET", "/v1/events", params);
        return { content: text(res) };
    }
);

// ==================== ANALYTICS ====================

server.tool(
    "monitor_count",
    "Count events matching filters. Returns a single number. Great for quick checks like 'how many errors in the last hour?'",
    {
        filters: z
            .array(
                z.object({
                    field: z.string().describe("Field name (service, env, name, level, user_id) or data.key for JSON fields"),
                    operator: z.enum(["eq", "neq", "lt", "gt", "lte", "gte", "contains", "startswith", "endswith", "in"]).optional().describe("Filter operator (default: eq)"),
                    value: z.any().describe("Filter value (string, number, or array for 'in' operator)"),
                })
            )
            .optional()
            .describe("Filter conditions"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to last 1 hour."),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
    },
    async ({ filters, from, to }) => {
        const body = {
            aggregation: "count",
            filters: filters || [],
            from: from || new Date(Date.now() - 3600000).toISOString(),
            to: to || new Date().toISOString(),
        };
        const res = await api("POST", "/v1/gauge", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_analytics",
    `Run an analytics aggregation query with optional grouping.

Aggregation types: count, count_unique, sum, avg, min, max, p50, p90, p95, p99
Group by fields: service, env, name, level, user_id, or data.key for JSON fields

Example: count events grouped by service and level to see error distribution across services.`,
    {
        aggregation: z.enum(["count", "count_unique", "sum", "avg", "min", "max", "p50", "p90", "p95", "p99"]).optional().describe("Aggregation type (default: count)"),
        field: z.string().optional().describe("Field to aggregate on (required for sum, avg, min, max, percentiles)"),
        group_by: z.array(z.string()).optional().describe("Fields to group by (e.g. ['service', 'level', 'data.endpoint'])"),
        filters: z
            .array(
                z.object({
                    field: z.string(),
                    operator: z.enum(["eq", "neq", "lt", "gt", "lte", "gte", "contains", "startswith", "endswith", "in"]).optional(),
                    value: z.any(),
                })
            )
            .optional()
            .describe("Filter conditions"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to last 1 hour."),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
        order_by: z.string().optional().describe("Order by 'value' or a group_by field"),
        order_desc: z.boolean().optional().describe("Sort descending (default: false)"),
        limit: z.number().optional().describe("Max results (1-10000, default 100)"),
    },
    async ({ aggregation, field, group_by, filters, from, to, order_by, order_desc, limit }) => {
        const body = {
            aggregation: aggregation || "count",
            filters: filters || [],
            from: from || new Date(Date.now() - 3600000).toISOString(),
            to: to || new Date().toISOString(),
        };
        if (field) body.field = field;
        if (group_by) body.group_by = group_by;
        if (order_by) body.order_by = order_by;
        if (order_desc) body.order_desc = order_desc;
        if (limit) body.limit = limit;

        const res = await api("POST", "/v1/analytics", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_timeseries",
    `Get event data as a time series for trend analysis. Shows how event counts or metrics change over time.

Intervals: minute, hour, day, week, month
Use group_by to split into multiple series (e.g. group by service to see per-service trends).`,
    {
        aggregation: z.enum(["count", "count_unique", "sum", "avg", "min", "max", "p50", "p90", "p95", "p99"]).optional().describe("Aggregation type (default: count)"),
        field: z.string().optional().describe("Field to aggregate on (required for sum, avg, min, max, percentiles)"),
        interval: z.enum(["minute", "hour", "day", "week", "month"]).describe("Time bucket interval"),
        group_by: z.array(z.string()).optional().describe("Fields to group by for multiple series"),
        filters: z
            .array(
                z.object({
                    field: z.string(),
                    operator: z.enum(["eq", "neq", "lt", "gt", "lte", "gte", "contains", "startswith", "endswith", "in"]).optional(),
                    value: z.any(),
                })
            )
            .optional()
            .describe("Filter conditions"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to last 24 hours."),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
        fill_zeros: z.boolean().optional().describe("Fill empty time buckets with zero (default: false)"),
    },
    async ({ aggregation, field, interval, group_by, filters, from, to, fill_zeros }) => {
        const body = {
            aggregation: aggregation || "count",
            interval,
            filters: filters || [],
            from: from || new Date(Date.now() - 86400000).toISOString(),
            to: to || new Date().toISOString(),
        };
        if (field) body.field = field;
        if (group_by) body.group_by = group_by;
        if (fill_zeros) body.fill_zeros = fill_zeros;

        const res = await api("POST", "/v1/timeseries", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_topn",
    "Get the top N values for a field. Great for finding the most common errors, busiest services, most active endpoints, etc.",
    {
        group_by: z.string().describe("Field to rank by (e.g. 'service', 'name', 'level', 'data.endpoint', 'data.error')"),
        aggregation: z.enum(["count", "count_unique", "sum", "avg", "min", "max", "p50", "p90", "p95", "p99"]).optional().describe("Aggregation type (default: count)"),
        field: z.string().optional().describe("Field to aggregate on (required for sum, avg, min, max, percentiles)"),
        filters: z
            .array(
                z.object({
                    field: z.string(),
                    operator: z.enum(["eq", "neq", "lt", "gt", "lte", "gte", "contains", "startswith", "endswith", "in"]).optional(),
                    value: z.any(),
                })
            )
            .optional()
            .describe("Filter conditions"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to last 1 hour."),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
        limit: z.number().optional().describe("Number of results (1-1000, default 10)"),
    },
    async ({ group_by, aggregation, field, filters, from, to, limit }) => {
        const body = {
            aggregation: aggregation || "count",
            group_by,
            filters: filters || [],
            from: from || new Date(Date.now() - 3600000).toISOString(),
            to: to || new Date().toISOString(),
            limit: limit || 10,
        };
        if (field) body.field = field;

        const res = await api("POST", "/v1/topn", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_compare",
    "Compare metrics between two time periods. Automatically calculates the previous period if not specified. Returns current value, previous value, absolute change, and percentage change.",
    {
        aggregation: z.enum(["count", "count_unique", "sum", "avg", "min", "max", "p50", "p90", "p95", "p99"]).optional().describe("Aggregation type (default: count)"),
        field: z.string().optional().describe("Field to aggregate on (required for sum, avg, min, max, percentiles)"),
        filters: z
            .array(
                z.object({
                    field: z.string(),
                    operator: z.enum(["eq", "neq", "lt", "gt", "lte", "gte", "contains", "startswith", "endswith", "in"]).optional(),
                    value: z.any(),
                })
            )
            .optional()
            .describe("Filter conditions"),
        from: z.string().describe("Current period start (RFC3339 or unix timestamp)"),
        to: z.string().describe("Current period end (RFC3339 or unix timestamp)"),
        compare_from: z.string().optional().describe("Previous period start (auto-calculated if omitted)"),
        compare_to: z.string().optional().describe("Previous period end (auto-calculated if omitted)"),
    },
    async ({ aggregation, field, filters, from, to, compare_from, compare_to }) => {
        const body = {
            aggregation: aggregation || "count",
            filters: filters || [],
            from,
            to,
        };
        if (field) body.field = field;
        if (compare_from) body.compare_from = compare_from;
        if (compare_to) body.compare_to = compare_to;

        const res = await api("POST", "/v1/compare", null, body);
        return { content: text(res) };
    }
);

// ==================== TRACE / REQUEST INVESTIGATION ====================

server.tool(
    "monitor_trace",
    "Get all events for a specific trace ID. Useful for following a distributed request across services.",
    {
        trace_id: z.string().describe("The trace ID to look up"),
        limit: z.number().optional().describe("Max events (default 100)"),
    },
    async ({ trace_id, limit }) => {
        const params = {
            trace_id,
            limit: limit || 100,
            from: new Date(Date.now() - 86400000 * 30).toISOString(),
        };
        const res = await api("GET", "/v1/events", params);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_request",
    "Get all events for a specific request ID. Shows the full lifecycle of a single request.",
    {
        request_id: z.string().describe("The request ID to look up"),
        limit: z.number().optional().describe("Max events (default 100)"),
    },
    async ({ request_id, limit }) => {
        const params = {
            request_id,
            limit: limit || 100,
            from: new Date(Date.now() - 86400000 * 30).toISOString(),
        };
        const res = await api("GET", "/v1/events", params);
        return { content: text(res) };
    }
);

// ==================== CONVENIENCE DIAGNOSTICS ====================

server.tool(
    "monitor_recent_errors",
    "Get the most recent error and fatal events. Quick way to see what's failing right now.",
    {
        service: z.string().optional().describe("Filter to a specific service"),
        limit: z.number().optional().describe("Max events (default 50)"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to last 1 hour."),
    },
    async ({ service, limit, from }) => {
        const params = {
            "level__in": "error,fatal",
            limit: limit || 50,
            from: from || new Date(Date.now() - 3600000).toISOString(),
        };
        if (service) params.service = service;

        const res = await api("GET", "/v1/events", params);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_error_breakdown",
    "Break down errors by event name or service. Shows which errors are most frequent.",
    {
        group_by: z.enum(["name", "service", "env", "data.error", "data.endpoint", "data.status_code"]).optional().describe("Field to group errors by (default: name)"),
        service: z.string().optional().describe("Filter to a specific service"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to last 1 hour."),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
        limit: z.number().optional().describe("Number of results (default 10)"),
    },
    async ({ group_by, service, from, to, limit }) => {
        const filters = [{ field: "level", operator: "in", value: ["error", "fatal"] }];
        if (service) filters.push({ field: "service", operator: "eq", value: service });

        const body = {
            aggregation: "count",
            group_by: group_by || "name",
            filters,
            from: from || new Date(Date.now() - 3600000).toISOString(),
            to: to || new Date().toISOString(),
            limit: limit || 10,
        };

        const res = await api("POST", "/v1/topn", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_error_trend",
    "Show error count over time. Useful for seeing if errors are increasing, spiking, or resolving.",
    {
        service: z.string().optional().describe("Filter to a specific service"),
        interval: z.enum(["minute", "hour", "day", "week"]).optional().describe("Time bucket interval (default: hour)"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to last 24 hours."),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
    },
    async ({ service, interval, from, to }) => {
        const filters = [{ field: "level", operator: "in", value: ["error", "fatal"] }];
        if (service) filters.push({ field: "service", operator: "eq", value: service });

        const body = {
            aggregation: "count",
            interval: interval || "hour",
            filters,
            from: from || new Date(Date.now() - 86400000).toISOString(),
            to: to || new Date().toISOString(),
            fill_zeros: true,
        };

        const res = await api("POST", "/v1/timeseries", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_service_overview",
    "Get a high-level overview of a service: total events, error count, error rate, and top event names. Good starting point for investigating a service.",
    {
        service: z.string().describe("Service name to analyze"),
        from: z.string().optional().describe("Start time (RFC3339 or unix timestamp). Defaults to last 1 hour."),
        to: z.string().optional().describe("End time (RFC3339 or unix timestamp)"),
    },
    async ({ service, from, to }) => {
        const timeFrom = from || new Date(Date.now() - 3600000).toISOString();
        const timeTo = to || new Date().toISOString();
        const serviceFilter = [{ field: "service", operator: "eq", value: service }];

        const [totalRes, errorsRes, topNamesRes, topErrorsRes] = await Promise.all([
            api("POST", "/v1/gauge", null, {
                aggregation: "count",
                filters: serviceFilter,
                from: timeFrom,
                to: timeTo,
            }),
            api("POST", "/v1/gauge", null, {
                aggregation: "count",
                filters: [...serviceFilter, { field: "level", operator: "in", value: ["error", "fatal"] }],
                from: timeFrom,
                to: timeTo,
            }),
            api("POST", "/v1/topn", null, {
                aggregation: "count",
                group_by: "name",
                filters: serviceFilter,
                from: timeFrom,
                to: timeTo,
                limit: 10,
            }),
            api("POST", "/v1/topn", null, {
                aggregation: "count",
                group_by: "name",
                filters: [...serviceFilter, { field: "level", operator: "in", value: ["error", "fatal"] }],
                from: timeFrom,
                to: timeTo,
                limit: 10,
            }),
        ]);

        const totalEvents = totalRes?.data?.value ?? 0;
        const totalErrors = errorsRes?.data?.value ?? 0;
        const errorRate = totalEvents > 0 ? ((totalErrors / totalEvents) * 100).toFixed(2) + "%" : "0%";

        const overview = {
            service,
            time_range: { from: timeFrom, to: timeTo },
            total_events: totalEvents,
            total_errors: totalErrors,
            error_rate: errorRate,
            top_event_names: topNamesRes?.data?.data ?? [],
            top_errors: topErrorsRes?.data?.data ?? [],
        };

        return { content: text(overview) };
    }
);

// ==================== ISSUES ====================

server.tool(
    "monitor_list_issues",
    "List error issues grouped by fingerprint. Issues aggregate repeated errors into a single trackable item with occurrence counts. Filter by status to see unresolved, resolved, or ignored issues.",
    {
        status: z.enum(["unresolved", "resolved", "ignored"]).optional().describe("Filter by issue status (default: all)"),
        service: z.string().optional().describe("Filter by service name"),
        limit: z.number().optional().describe("Max issues to return (default 50)"),
        offset: z.number().optional().describe("Pagination offset (default 0)"),
    },
    async ({ status, service, limit, offset }) => {
        const params = {};
        if (status) params.status = status;
        if (service) params.service = service;
        if (limit) params.limit = limit;
        if (offset) params.offset = offset;
        const res = await api("GET", "/v1/issues", params);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_get_issue",
    "Get full details of a specific issue by ID, including fingerprint, service, message, status, occurrence count, and timestamps.",
    {
        id: z.string().describe("The issue ID"),
    },
    async ({ id }) => {
        const res = await api("GET", `/v1/issues/${id}`);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_update_issue",
    "Update an issue's status — resolve, unresolve, or ignore it.",
    {
        id: z.string().describe("The issue ID"),
        status: z.enum(["resolved", "unresolved", "ignored"]).describe("New status for the issue"),
    },
    async ({ id, status }) => {
        const res = await api("PUT", `/v1/issues/${id}`, null, { status });
        return { content: text(res) };
    }
);

server.tool(
    "monitor_get_issue_events",
    "Get events associated with a specific issue. Shows individual occurrences of the grouped error.",
    {
        id: z.string().describe("The issue ID"),
        limit: z.number().optional().describe("Max events to return (default 50, max 500)"),
    },
    async ({ id, limit }) => {
        const params = {};
        if (limit) params.limit = limit;
        const res = await api("GET", `/v1/issues/${id}/events`, params);
        return { content: text(res) };
    }
);

// ==================== API KEYS ====================

server.tool(
    "monitor_list_api_keys",
    "List all API keys for the Monitor instance. Shows key metadata (name, scope, prefix) but not the full key value.",
    {},
    async () => {
        const res = await api("GET", "/v1/api-keys");
        return { content: text(res) };
    }
);

server.tool(
    "monitor_create_api_key",
    "Create a new API key. The full key is only shown once, and this server masks it to its first two characters — the key will exist but you will not be able to read it here. Create keys in the Monitor UI when you need the value, or set MONITOR_ALLOW_SECRET_VALUES=1.",
    {
        name: z.string().describe("Human-readable name for the key (e.g. 'frontend-ingest', 'ci-admin')"),
        scope: z.enum(["admin", "ingest"]).describe("Key scope — 'ingest' for event ingestion only, 'admin' for full access"),
    },
    async ({ name, scope }) => {
        const res = await api("POST", "/v1/api-keys", null, { name, scope });
        return { content: text(res) };
    }
);

server.tool(
    "monitor_delete_api_key",
    "Delete an API key by ID. This immediately revokes access for anything using this key.",
    {
        id: z.string().describe("The API key ID to delete"),
    },
    async ({ id }) => {
        const res = await api("DELETE", `/v1/api-keys/${id}`);
        return { content: text(res) };
    }
);

// ==================== ALERT RULES ====================

server.tool(
    "monitor_list_alert_rules",
    "List all configured alert rules with their current state (enabled/disabled, firing status, thresholds).",
    {},
    async () => {
        const res = await api("GET", "/v1/alert-rules");
        return { content: text(res) };
    }
);

server.tool(
    "monitor_test_alert_rule",
    "Test an alert rule by evaluating it against current data. Returns the current value, threshold, condition, and whether it would fire.",
    {
        id: z.string().describe("The alert rule ID to test"),
    },
    async ({ id }) => {
        const res = await api("POST", `/v1/alert-rules/${id}/test`);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_create_alert_rule",
    "Create a new alert rule. Types: threshold (value crosses limit), absence (no events in window), rate_change (sudden spike/drop). Conditions: gt, lt, gte, lte, eq. Priority: P0 (critical), P1 (high), P2 (medium), P3 (low). query_filters is a JSON array of {field, operator, value} objects to scope the query (e.g. [{\"field\":\"service\",\"operator\":\"eq\",\"value\":\"auth-service-v2\"}]).",
    {
        name: z.string().describe("Human-readable alert name"),
        description: z.string().optional().describe("Description of what this alert monitors"),
        type: z.enum(["threshold", "absence", "rate_change"]).describe("Alert type"),
        priority: z.enum(["P0", "P1", "P2", "P3"]).optional().describe("Priority level (default P2)"),
        query_filters: z.string().describe("JSON array of filter objects: [{\"field\":\"service\",\"operator\":\"eq\",\"value\":\"scraper-service\"},{\"field\":\"name\",\"operator\":\"eq\",\"value\":\"scraper.ai.exhausted\"}]"),
        metric: z.enum(["count", "avg", "max", "min", "sum", "p50", "p95", "p99"]).optional().describe("Metric to evaluate (default: count)"),
        field: z.string().optional().describe("Data field for metric (e.g. data.duration_ms). Required for avg/max/min/sum/percentile metrics."),
        condition: z.enum(["gt", "lt", "gte", "lte", "eq"]).describe("Comparison condition"),
        threshold: z.number().describe("Threshold value"),
        evaluation_interval_seconds: z.number().optional().describe("How often to check (default 60)"),
        for_seconds: z.number().optional().describe("How long condition must hold before firing (default 0)"),
        cooldown_seconds: z.number().optional().describe("Min time between notifications (default 300)"),
        notification_channel_ids: z.string().optional().describe("JSON array of channel IDs to notify"),
        enabled: z.boolean().optional().describe("Whether the rule is active (default true)"),
    },
    async (params) => {
        const body = { ...params };
        if (body.enabled === undefined) body.enabled = true;
        const res = await api("POST", "/v1/alert-rules", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_update_alert_rule",
    "Update an existing alert rule. This is a partial update: only fields you provide are sent, and any field you omit is left unchanged (including `enabled` — omit it to keep the rule's current on/off state; set it explicitly only when you intend to enable or disable the rule).",
    {
        id: z.string().describe("The alert rule ID to update"),
        name: z.string().optional().describe("New name"),
        description: z.string().optional().describe("New description"),
        type: z.enum(["threshold", "absence", "rate_change"]).optional(),
        priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
        query_filters: z.string().optional(),
        metric: z.string().optional(),
        field: z.string().optional(),
        condition: z.enum(["gt", "lt", "gte", "lte", "eq"]).optional(),
        threshold: z.number().optional(),
        evaluation_interval_seconds: z.number().optional(),
        for_seconds: z.number().optional(),
        cooldown_seconds: z.number().optional(),
        notification_channel_ids: z.string().optional(),
        enabled: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
        // Only send fields the caller actually provided. In particular, never
        // send enabled:false just because it was omitted — that would disable
        // the rule (belt-and-suspenders alongside the backend preserving it).
        const partial = {};
        for (const [k, v] of Object.entries(body)) {
            if (v !== undefined) partial[k] = v;
        }
        const res = await api("PUT", `/v1/alert-rules/${id}`, null, partial);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_delete_alert_rule",
    "Delete an alert rule by ID.",
    {
        id: z.string().describe("The alert rule ID to delete"),
    },
    async ({ id }) => {
        const res = await api("DELETE", `/v1/alert-rules/${id}`);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_list_alert_history",
    "List alert firing history. Shows when alerts triggered and resolved over time.",
    {
        rule_id: z.string().optional().describe("Filter to a specific alert rule"),
        limit: z.number().optional().describe("Max entries to return (default 50)"),
        offset: z.number().optional().describe("Pagination offset (default 0)"),
    },
    async ({ rule_id, limit, offset }) => {
        const params = {};
        if (rule_id) params.rule_id = rule_id;
        if (limit) params.limit = limit;
        if (offset) params.offset = offset;
        const res = await api("GET", "/v1/alert-history", params);
        return { content: text(res) };
    }
);

// ==================== NOTIFICATION CHANNELS ====================

server.tool(
    "monitor_list_notification_channels",
    "List all notification channels. Use this to discover channel IDs to wire into an alert rule's notification_channel_ids. Each channel has an id, name, type (webhook/slack/email/pagerduty), and config.",
    {},
    async () => {
        const res = await api("GET", "/v1/notification-channels");
        return { content: text(res) };
    }
);

server.tool(
    "monitor_create_notification_channel",
    "Create a notification channel that alert rules can notify. Returns the created channel including its generated id. The `config` field is a JSON *string* whose shape depends on `type` (e.g. webhook: {\"url\":\"https://...\"}, slack: {\"webhook_url\":\"https://hooks.slack.com/...\"}, email: {\"to\":\"a@b.com\"}, pagerduty: {\"routing_key\":\"...\"}).",
    {
        name: z.string().describe("Human-readable channel name"),
        type: z.enum(["webhook", "slack", "email", "pagerduty"]).describe("Channel type"),
        config: z.string().optional().describe("Channel configuration as a JSON string (type-dependent). Defaults to empty."),
    },
    async ({ name, type, config }) => {
        const body = { name, type };
        if (config !== undefined) body.config = config;
        const res = await api("POST", "/v1/notification-channels", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_delete_notification_channel",
    "Delete a notification channel by ID. Alert rules referencing it will no longer notify through this channel.",
    {
        id: z.string().describe("The notification channel ID to delete"),
    },
    async ({ id }) => {
        const res = await api("DELETE", `/v1/notification-channels/${id}`);
        return { content: text(res) };
    }
);

// ==================== SSO / AUTH ====================

server.tool(
    "monitor_get_sso_config",
    "List the PUBLIC SSO login options (GET /auth/sso/config). This is the unauthenticated provider-discovery endpoint the login page uses: it returns only the ENABLED providers as {slug, button_label, login_url} — never any secret, client_id, or endpoint URL. No admin session required.",
    {},
    async () => {
        const res = await api("GET", "/auth/sso/config");
        return { content: text(res) };
    }
);

server.tool(
    "monitor_list_sso_providers",
    "List all SSO providers with their full admin configuration (GET /admin/sso-providers). Each provider includes has_secret (a boolean — the client_secret is NEVER returned) plus all URL/claim/flag fields. ADMIN SESSION REQUIRED: this route is behind monitor-core's SessionMiddleware + RequireAdmin, which accepts only a Bearer access JWT (or mon-access-token cookie), NOT the X-Api-Key. Set MONITOR_SESSION_TOKEN to an admin access JWT or this returns 401/403.",
    {},
    async () => {
        const res = await api("GET", "/admin/sso-providers");
        return { content: text(res) };
    }
);

server.tool(
    "monitor_create_sso_provider",
    "Create an SSO provider (POST /admin/sso-providers). slug and display_name are required; everything else is optional. kind is oidc (default) or oauth2 — OIDC providers set issuer_url (endpoints are discovered), OAuth2 providers set authorize_url/token_url/userinfo_url (and optionally introspect_url) explicitly. client_secret is PLAINTEXT and write-only: it is AES-256-GCM encrypted at rest and never echoed back (the response exposes only has_secret). Provide EITHER client_secret (encrypted at rest) OR client_secret_ref (a Keyring secret name), not both. scopes is a single space-separated string. ADMIN SESSION REQUIRED (SessionMiddleware + RequireAdmin, Bearer JWT only — X-Api-Key is rejected; set MONITOR_SESSION_TOKEN).",
    {
        slug: z.string().describe("URL-safe unique identifier (required), e.g. \"google\" or \"okta\""),
        display_name: z.string().describe("Human-readable provider name (required)"),
        kind: z.enum(["oidc", "oauth2"]).optional().describe("Provider protocol: oidc (default) or oauth2"),
        issuer_url: z.string().optional().describe("OIDC issuer URL (endpoints auto-discovered). SSRF-validated."),
        authorize_url: z.string().optional().describe("OAuth2 authorization endpoint. SSRF-validated."),
        token_url: z.string().optional().describe("OAuth2 token endpoint. SSRF-validated."),
        userinfo_url: z.string().optional().describe("OAuth2/OIDC userinfo endpoint. SSRF-validated."),
        jwks_url: z.string().optional().describe("JWKS endpoint for verifying ID tokens. SSRF-validated."),
        introspect_url: z.string().optional().describe("OAuth2 token introspection endpoint (used by the SSO revocation checkpoint). SSRF-validated."),
        client_id: z.string().optional().describe("OAuth2/OIDC client id"),
        client_secret: z.string().optional().describe("PLAINTEXT client secret — write-only, AES-256-GCM encrypted at rest, never returned. Mutually exclusive with client_secret_ref."),
        client_secret_ref: z.string().optional().describe("Keyring secret name to resolve the client secret from. Mutually exclusive with client_secret."),
        scopes: z.string().optional().describe("Space-separated OAuth scopes, e.g. \"openid email profile\""),
        email_claim: z.string().optional().describe("Claim/field holding the user's email (e.g. \"email\")"),
        email_verified_claim: z.string().optional().describe("Claim/field holding the email-verified boolean (e.g. \"email_verified\")"),
        subject_claim: z.string().optional().describe("Claim/field holding the stable subject id (e.g. \"sub\")"),
        trust_email_verified: z.boolean().optional().describe("Whether to trust the IdP's email_verified claim for auto-linking"),
        allow_auto_link: z.boolean().optional().describe("Auto-link an SSO identity to an existing user with a matching verified email"),
        auto_provision: z.boolean().optional().describe("Auto-create a (pending) user on first SSO login when no matching account exists"),
        button_label: z.string().optional().describe("Override text for the login button (defaults to display_name)"),
        enabled: z.boolean().optional().describe("Whether the provider is active and shown on the login page"),
    },
    async (body) => {
        const payload = {};
        for (const [k, v] of Object.entries(body)) {
            if (v !== undefined) payload[k] = v;
        }
        const res = await api("POST", "/admin/sso-providers", null, payload);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_update_sso_provider",
    "Update an SSO provider by slug (PUT /admin/sso-providers/{slug}). PARTIAL update: only the fields you provide are sent and changed; omitted fields are left unchanged. The slug itself is the path key and cannot be changed here. client_secret is plaintext/write-only (re-encrypted at rest, never returned); provide client_secret OR client_secret_ref. ADMIN SESSION REQUIRED (SessionMiddleware + RequireAdmin, Bearer JWT only — X-Api-Key is rejected; set MONITOR_SESSION_TOKEN).",
    {
        slug: z.string().describe("Slug of the provider to update (path parameter, immutable)"),
        display_name: z.string().optional().describe("New display name"),
        kind: z.enum(["oidc", "oauth2"]).optional().describe("Provider protocol: oidc or oauth2"),
        issuer_url: z.string().optional().describe("OIDC issuer URL. SSRF-validated."),
        authorize_url: z.string().optional().describe("OAuth2 authorization endpoint. SSRF-validated."),
        token_url: z.string().optional().describe("OAuth2 token endpoint. SSRF-validated."),
        userinfo_url: z.string().optional().describe("OAuth2/OIDC userinfo endpoint. SSRF-validated."),
        jwks_url: z.string().optional().describe("JWKS endpoint. SSRF-validated."),
        introspect_url: z.string().optional().describe("OAuth2 introspection endpoint. SSRF-validated."),
        client_id: z.string().optional().describe("OAuth2/OIDC client id"),
        client_secret: z.string().optional().describe("PLAINTEXT client secret — write-only, encrypted at rest, never returned. Mutually exclusive with client_secret_ref."),
        client_secret_ref: z.string().optional().describe("Keyring secret name. Mutually exclusive with client_secret."),
        scopes: z.string().optional().describe("Space-separated OAuth scopes"),
        email_claim: z.string().optional().describe("Email claim/field name"),
        email_verified_claim: z.string().optional().describe("Email-verified claim/field name"),
        subject_claim: z.string().optional().describe("Subject-id claim/field name"),
        trust_email_verified: z.boolean().optional().describe("Trust the IdP's email_verified claim"),
        allow_auto_link: z.boolean().optional().describe("Auto-link to an existing user by verified email"),
        auto_provision: z.boolean().optional().describe("Auto-create a pending user on first login"),
        button_label: z.string().optional().describe("Login button label"),
        enabled: z.boolean().optional().describe("Whether the provider is active"),
    },
    async ({ slug, ...body }) => {
        const payload = {};
        for (const [k, v] of Object.entries(body)) {
            if (v !== undefined) payload[k] = v;
        }
        const res = await api("PUT", `/admin/sso-providers/${slug}`, null, payload);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_delete_sso_provider",
    "Delete an SSO provider by slug (DELETE /admin/sso-providers/{slug}). ADMIN SESSION REQUIRED (SessionMiddleware + RequireAdmin, Bearer JWT only — X-Api-Key is rejected; set MONITOR_SESSION_TOKEN).",
    {
        slug: z.string().describe("Slug of the provider to delete"),
    },
    async ({ slug }) => {
        const res = await api("DELETE", `/admin/sso-providers/${slug}`);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_get_self",
    "Get the currently authenticated Monitor user and their linked sign-in identities (GET /auth/self). Returns the neutral user record (no password hash) plus an identities array of linked providers. SESSION REQUIRED: this route is behind SessionMiddleware and identifies the user FROM the session token, so it reflects whoever MONITOR_SESSION_TOKEN belongs to — X-Api-Key is not accepted and there is no way to look up an arbitrary user here. Returns 401 if MONITOR_SESSION_TOKEN is unset.",
    {},
    async () => {
        const res = await api("GET", "/auth/self");
        return { content: text(res) };
    }
);

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
