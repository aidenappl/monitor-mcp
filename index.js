#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createInterface } from "readline";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Interactive setup ---

if (process.argv.includes("--setup")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

    console.log("\n  Monitor MCP Setup\n");

    const apiUrl = (await ask("  Monitor API URL (https://monitor.appleby.cloud): ")).trim() || "https://monitor.appleby.cloud";
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

if (!API_URL || !API_KEY) {
    console.error("MONITOR_API_URL and MONITOR_API_KEY are required.");
    console.error("Run `npx monitor-mcp --setup` to configure.");
    process.exit(1);
}

// --- API helper ---

async function api(method, path, params, body) {
    const url = new URL(path, API_URL);
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

    if (body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }

    try {
        const res = await fetch(url.toString(), opts);
        return await res.json();
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function text(data) {
    return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}

// --- Server ---

const server = new McpServer({
    name: "monitor",
    version: "1.0.0",
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

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
