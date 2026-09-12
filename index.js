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

// api() is the one chokepoint every tool goes through: httpRequest does the call
// and the masking, withProjectScope annotates the answer with the project that
// produced it. Both halves are central rather than per-tool, so a newly added
// tool is masked and scope-labelled by default rather than by remembering.
async function api(method, path, params, body) {
    return withProjectScope(path, await httpRequest(method, path, params, body));
}

async function httpRequest(method, path, params, body) {
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

// --- Project scope (multi-tenancy) ---
//
// THERE IS NO `project` PARAMETER ON ANY TOOL, AND ADDING ONE WOULD BE A BUG.
//
// Monitor is multi-tenant: every event carries a `project`, stamped server-side
// at ingest from the api_keys row behind the presented key. The READ side works
// the same way. In `monitor-core/middleware/query_auth.go`, the DB admin-key
// branch of QueryAuthMiddleware resolves the tenant from that key's OWN row —
// `scope.WithProject(ctx, identity.ProjectSlug)` — and deliberately ignores any
// `?project` on the request. Its comment says why: "admin" is a scope over VERBS
// (query vs. ingest), never over tenants, so an admin key reads only its own
// project and a request-supplied slug must never be able to move a real
// boundary. A `project` sent from here does not even reach that decision; it
// arrives as an ordinary filter column that can narrow the mandatory predicate
// and never widen it.
//
// So a `project` parameter on these tools would be AN INPUT THE HANDLER SILENTLY
// IGNORES: the model would pass "atlas", the server would answer for the key's
// own project, and neither side would say anything. That is precisely the class
// of defect every bug shipped across the five *-mcp servers has come from —
// wrong units, wrong enum values, wrong content type, or a parameter the handler
// ignores.
//
// TO READ ANOTHER PROJECT, ADD A SECOND `~/.mcp.json` ENTRY whose
// MONITOR_API_KEY is a key bound to that project (e.g. a "monitor-atlas" server
// alongside "monitor"). That is the same asymmetry that already makes zones
// free: a zone is a whole monitor-core install with its own URL and its own
// keys, so it is a second entry too. monitor-web *does* get a `?project`
// selector — see withSessionProject in the same middleware file — but that is a
// session, which has no credential-side tenant to derive; this server
// authenticates with a credential that does.
//
// What this server does instead is say which project answered — see below.
//
// --- ZONE IS THE OPPOSITE CASE, AND THE `zone` PARAMETER ON WRITES IS NOT A BUG ---
//
// EVERYTHING ABOVE IS ABOUT `project`. It does NOT transfer to `zone`, and
// reading it as though it did is exactly how someone later "fixes" this file by
// deleting a parameter that is load-bearing.
//
// A project is selected by a CREDENTIAL inside one process: the slug never
// reaches a decision at all, so a parameter for it is a parameter the handler
// ignores. A zone is a WHOLE SEPARATE PROCESS — its own binary, its own
// ClickHouse, its own MariaDB, its own URL — so WHICH zone answers is settled by
// MONITOR_API_URL before the request is even sent. That makes the zone
// checkable, and on writes it makes checking it necessary: monitor-core's
// apikeys.resolveProject binds a new key to a project in the zone of the
// ANSWERING PROCESS (`env.ZoneSlug`), looked up in that process's own MariaDB.
// Point this server at the control plane, ask for an ingest key "for appleby",
// and you get a 200 and a key bound to a TRAILBLAZE project; the service wired
// to it then reports into the wrong tenant, permanently, with nothing on either
// side saying so. Every other write here has the same shape — alert rules,
// notification channels, service→repo mappings and SSO providers are all rows in
// the answering zone's own MariaDB, and none of them names a zone in its body.
//
// So the `zone` parameter on the write tools is VERIFIED, NEVER ROUTED. It is
// not forwarded to monitor-core, it never lands in a request body or query
// string, and it cannot send a request anywhere: requireZone() compares it
// against `zone` from GET /health — the answering process's own identity, which
// monitor-core publishes for precisely this purpose — and REFUSES the call on a
// mismatch. That is the whole difference from `project` in one line: `project`
// would be an input nothing reads, `zone` is an assertion this server itself
// checks. A required parameter that can only ever turn a silent wrong-tenant
// write into a loud error is not the defect §5 warns about; it is its cure.
//
// DO NOT REMOVE IT, and do not "make it optional so it matches the reads". A
// read carrying the wrong zone label costs a re-read; a write bound to the wrong
// zone cannot be un-bound.

// The zone, project and URL this server speaks for, resolved together and
// reused for a short TTL (see projectScope()).
//
// ZONE comes from GET /health. That endpoint reports `zone` (and `role`) as THIS
// PROCESS'S OWN IDENTITY — monitor-core stamps it from env.ZoneSlug, unauthenticated,
// with a comment saying it exists so a caller can tell "a monitor-core answered"
// apart from "the monitor-core I meant answered". It is therefore the only
// authoritative answer to "which zone am I talking to", and it is right whether the
// URL points at the control plane or at a zone.
//
// It replaces an earlier reading of GET /v1/zones, which counted rows and used the
// slug only when there was exactly ONE. That was a registry LISTING, not an
// identity: it answers "which zones does this install know about", so the moment a
// second zone was registered the count stopped being one and `zone` silently
// vanished from every `_scope` — at exactly the moment multi-zone made it
// load-bearing. A fleet-wide registry can never identify the process serving it.
//
// PROJECT comes from GET /v1/api-keys, which is not an inference either:
// apikeys.List filters that listing by the project QueryAuthMiddleware resolved for
// the request, and every row carries that project's slug, so the value read back IS
// the server's own answer to "whose data am I reading?" — the same context value
// every event query is scoped by. Nothing echoes it more directly: an API key has no
// /self, and monitor-core sets no project response header. Note the install's
// `default_project_slug` (from monitor_list_projects) is NOT this: that is what an
// unset selector resolves to for a browser session, and a key bound to a
// non-default project answers for its own regardless.
//
// API_URL is echoed verbatim. It costs nothing and it closes the last ambiguity:
// zone, project and URL together state which process answered, whose data it
// answered with, and where to look — three facts no single response field carries.
const SCOPE_TTL_MS = 5 * 60 * 1000;
const SCOPE_FAILURE_TTL_MS = 30 * 1000;

// Cached as a single promise INCLUDING WHEN IT FAILS. Resolving per call would
// double the request count of every tool; retrying after a failure would do that
// forever on an install where the label simply cannot be read. A label must
// never cost more than the answer it labels, and must never withhold one — an
// unresolved scope degrades to a note, never to an error.
//
// But it is no longer cached FOREVER, which is what it was. A memo with no
// expiry means a long-running server reports the fleet it booted into: a process
// started when there was one zone kept answering with that snapshot for days,
// through a second zone being added, and could not be corrected short of a
// restart. Five minutes on success is far longer than a burst of tool calls and
// far shorter than a shift; thirty seconds on failure keeps the "do not hammer a
// broken endpoint" property while letting a transient outage heal on its own.
// Both are read at CALL time — never captured into a module-level constant,
// which would freeze the clock at import.
let scopePromise = null;
let scopeExpiresAt = 0;

function projectScope() {
    const now = Date.now();
    if (scopePromise && now < scopeExpiresAt) return scopePromise;

    // Stamp the SHORT ttl before the request is made, and extend it only once a
    // fully-resolved answer comes back. A promise that rejects, never settles,
    // or settles with a gap in it therefore expires quickly instead of pinning
    // a degraded label for the full success window.
    scopeExpiresAt = now + SCOPE_FAILURE_TTL_MS;
    const pending = resolveProjectScope().then(
        (scope) => {
            // `scopePromise === pending` so a superseded in-flight resolve can
            // never push out the expiry of the one that replaced it.
            if (scopePromise === pending && scope && scope.project && scope.zone) {
                scopeExpiresAt = Date.now() + SCOPE_TTL_MS;
            }
            return scope;
        },
        (err) => {
            // resolveProjectScope's own calls cannot throw — httpRequest catches
            // and returns an error object — so this is the belt: a label that
            // throws still degrades to a note rather than rejecting into every
            // tool that awaits it.
            return {
                project: null,
                api_url: API_URL,
                note: `scope could not be resolved (${err?.message ?? err}); answers are still scoped to whichever zone MONITOR_API_URL points at and whichever project MONITOR_API_KEY is bound to`,
            };
        }
    );
    scopePromise = pending;
    return pending;
}

async function resolveProjectScope() {
    const [keys, health] = await Promise.all([
        httpRequest("GET", "/v1/api-keys"),
        httpRequest("GET", "/health"),
    ]);

    // /health is a bare object, not a responder envelope, so `zone` is at the
    // root. An older monitor-core that predates multi-zone omits the key
    // entirely — treated as "unreadable", not as a zone named "undefined".
    const zone = typeof health?.zone === "string" && health.zone !== "" ? health.zone : null;
    const role = typeof health?.role === "string" && health.role !== "" ? health.role : null;

    const keyRows = Array.isArray(keys?.data) ? keys.data : [];
    const project = keyRows
        .map((k) => k?.project_slug)
        .find((slug) => typeof slug === "string" && slug !== "") ?? null;

    // Honest about each gap rather than silent about it: the answers being
    // labelled are still scoped, only the label for that scope is unavailable.
    // Each half degrades on its own, so losing one does not cost the other.
    const notes = [];
    if (project) {
        notes.push("events, issues and analytics answers are limited to this project. It is fixed by the api_keys row behind MONITOR_API_KEY and cannot be selected per request — reach another project with a second ~/.mcp.json entry whose key is bound to it.");
    } else {
        const reason = keys?.success === false
            ? `HTTP ${keys.http_status ?? "error"}`
            : "no key rows returned";
        notes.push(`answering project could not be resolved (GET /v1/api-keys: ${reason}); results are still scoped to whichever project MONITOR_API_KEY is bound to`);
    }
    if (!zone) {
        const reason = health?.success === false
            ? `HTTP ${health.http_status ?? "error"}`
            : "no zone reported (a monitor-core predating multi-zone)";
        notes.push(`answering zone could not be resolved (GET /health: ${reason}); the answer still came from whichever zone MONITOR_API_URL points at, and zone-binding writes will refuse until it can be read`);
    }

    // Composed as one literal so the key order states the three facts in the
    // order a reader needs them: which zone, which project, which URL.
    return {
        ...(zone ? { zone } : {}),
        ...(role ? { role } : {}),
        project,
        api_url: API_URL,
        note: notes.join(" "),
    };
}

// --- Zone verification for writes ---
//
// requireZone() is the guard behind every zone-binding write. It resolves this
// server's ACTUAL zone from /health (through the same memo above, so the check
// costs nothing per call) and compares it with the zone the caller named.
//
// Returns null when they agree — call sites read as `if (refusal) return refusal;`
// — and a finished, isError tool result when they do not. A refusal rather than a
// thrown exception because the model has to be able to read WHY: the message names
// both zones and says what to do instead, which a stack trace does not.
//
// IT FAILS CLOSED when the zone cannot be read at all, and that asymmetry with
// the `_scope` label above is deliberate. A missing label costs a re-read; an
// unverified write is the exact failure this exists to prevent, and it is
// permanent — a key bound to the wrong project cannot be re-bound, and the
// service wired to it reports into another tenant until someone notices. The
// failure TTL is 30s, so a transient /health blip blocks writes briefly rather
// than for the process lifetime.
async function requireZone(zone) {
    const requested = typeof zone === "string" ? zone.trim() : "";
    const scope = await projectScope().catch(() => null);
    const actual = typeof scope?.zone === "string" && scope.zone !== "" ? scope.zone : null;

    if (!actual) {
        return zoneRefusal({
            error: "zone_unverifiable",
            error_message: `this server could not read its own zone from GET /health, so a write that would bind to a zone is refused rather than guessed. ${scope?.note ?? ""}`.trim(),
            requested_zone: requested || null,
            api_url: API_URL,
            what_to_do: "Check monitor_health. A monitor-core that reports no `zone` predates multi-zone — upgrade it, or perform this write from the Monitor UI where the zone is visible.",
        });
    }

    if (requested !== actual) {
        return zoneRefusal({
            error: "zone_mismatch",
            error_message: `refused: this MCP server talks to zone "${actual}" (MONITOR_API_URL=${API_URL}), not "${requested || "(empty)"}". The write was NOT sent. monitor-core binds a write to the zone of the process that answers it, so sending this would have created the resource in "${actual}" under the name of a zone it has nothing to do with, returned 200, and said nothing.`,
            requested_zone: requested || null,
            actual_zone: actual,
            api_url: API_URL,
            what_to_do: `Use the ~/.mcp.json entry configured for zone "${requested || "the zone you want"}" — one with that zone's own MONITOR_API_URL and a key from it. A zone is a separate deployment; there is no request from here that can reach it.`,
        });
    }

    return null;
}

function zoneRefusal(body) {
    return { content: text({ success: false, ...body }), isError: true };
}

// One shared description so twelve copies cannot drift, and so the reasoning
// travels with the parameter to whoever reads the tool list rather than the file.
const ZONE_PARAM_DESC =
    "REQUIRED. The zone this write must land in (e.g. \"trailblaze\"). It is VERIFIED, NOT ROUTED: this MCP server talks to exactly one zone — the one MONITOR_API_URL points at — and the call is REFUSED, unsent, if this does not match it. It exists because monitor-core binds a write to the zone of the process that answers, so a wrong-zone write would otherwise return 200 and silently create the resource in the wrong tenant. Get the value from monitor_health or from `_scope.zone` on any read; do NOT guess it from monitor_list_zones, which lists zones this install knows about, not the one it is.";

// The /v1 paths that are NOT project-scoped, and so must NOT be labelled. A
// label on one of these would assert a filter that is not there — a "wrong
// answer that looks right", which is the failure the label exists to prevent, so
// silence is the only honest option.
//
// The list is a DENYLIST on purpose: a newly added tool is labelled by default,
// the same way sanitise() masks by default. If you add a tool for a route that
// reads global configuration rather than a tenant's data, add its path here —
// the check is whether the handler's chain reaches scope.ProjectPredicate,
// scopeIssues or apikeys.List in monitor-core.
//
// Verified against monitor-core 9cab9e2:
//   zones/projects       registry reads (query.ListZones / ListProjects), no project filter
//   service-repos        one service→repo mapping serves every project
//   alert-rules (config) rules, channels and history are global rows in MariaDB
//   dashboards, views    UI persistence, no tool today, listed so a future one starts right
//
// `/v1/alert-rules/{id}/test` is deliberately NOT exempt, which is why the
// alert-rules pattern stops at one path segment: the rule row is global, but
// testing one EVALUATES it, and alerts/evaluator.go:335 applies
// scope.ProjectPredicate to that read — so the value returned is this project's.
const SCOPE_ECHO_EXEMPT = [
    /^\/v1\/zones(\/|$)/,
    /^\/v1\/service-repos(\/|$)/,
    /^\/v1\/notification-channels(\/|$)/,
    /^\/v1\/alert-history(\/|$)/,
    /^\/v1\/(dashboards|views)(\/|$)/,
    /^\/v1\/alert-rules(\/[^/]+)?$/,
];

// Annotates a project-scoped response with the scope that produced it, under a
// leading-underscore key so it reads as this server's annotation and not as a
// field monitor-core returned.
async function withProjectScope(path, payload) {
    const p = path.startsWith("/") ? path : "/" + path;

    // /health, /auth/* and /admin/* are not project-scoped surfaces.
    if (!p.startsWith("/v1/")) return payload;
    if (SCOPE_ECHO_EXEMPT.some((re) => re.test(p))) return payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;

    try {
        const scope = await projectScope();
        return scope ? { ...payload, _scope: scope } : payload;
    } catch {
        // Never let the label break the query it was labelling.
        return payload;
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
//
// `depth` exists because `data` names two different things. monitor-core's
// responder wraps EVERY payload as {success, message, data, pagination}, so the
// ROOT `data` is the envelope — the whole response body — while a `data` inside
// a row is the free-form event payload OPAQUE_FIELDS is meant to skip. Treating
// both alike made the exemption swallow the entire response, so nothing was ever
// masked against a real monitor-core: monitor_create_api_key returned its live
// admin key in full, past the mask this block exists to apply. The opaque rule
// therefore applies only BELOW the envelope.
function sanitise(node, depth = 0) {
    if (ALLOW_SECRETS || node === null || typeof node !== "object") return node;
    // An array is not a naming level — its rows sit at the depth the array
    // itself did, so an event row's own `data` is still opaque. Mapped through a
    // lambda rather than `map(sanitise)`, which would pass the index as `depth`.
    if (Array.isArray(node)) return node.map((item) => sanitise(item, depth));
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (OPAQUE_FIELDS.has(k) && depth > 0) {
            out[k] = v;
        } else if (SECRET_FIELDS.has(k) && typeof v === "string") {
            out[k] = mask(v);
        } else {
            out[k] = sanitise(v, depth + 1);
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

// Also this server's identity oracle: /health is where monitor-core publishes
// `zone` and `role` for the process answering, unauthenticated and for exactly
// this purpose ("tell 'a monitor-core answered' apart from 'the monitor-core I
// meant answered'"). resolveProjectScope() and requireZone() both read it.
server.tool("monitor_health", "Check Monitor API health — queue stats (enqueued, dropped, pending), store reachability (clickhouse_ok, mariadb_ok, alerting_ok), and the ANSWERING PROCESS'S OWN IDENTITY: `zone` (which zone this URL serves) and `role` (both | zone | app). That `zone` is the authoritative answer to \"which zone am I talking to\" — the one the zone-binding write tools verify against, and the one echoed as `_scope.zone` on project-scoped reads. Do not infer it from monitor_list_zones, which lists the registry rather than the process.", {}, async () => {
    const res = await api("GET", "/health");
    return { content: text(res) };
});

// ==================== ZONES & PROJECTS (TENANCY) ====================
//
// A ZONE is one whole monitor-core install — its own ClickHouse instance, its own
// URL, its own API keys. A PROJECT is a tenant inside one zone, and is the
// dimension every event is filed under. Both routes are reads with no
// create/update/delete counterpart: the registry is seeded by
// bootstrap.EnsureZoneAndProject and managed out of band, and slugs are immutable
// and never reusable, so a mistyped one could only ever be retired.
//
// Neither response carries a `_scope` annotation (SCOPE_ECHO_EXEMPT): they
// answer about a registry, not about the project this server's key reads. Which
// makes the trap worth stating plainly — THE REGISTRY DOES NOT IDENTIFY THE
// PROCESS SERVING IT. Both routes read the answering process's own MariaDB, so
// the control plane returns the whole fleet and a zone returns itself, and the
// response is identical in shape either way. `zone` on GET /health is the
// process's own identity and is the only thing that answers "which zone am I
// talking to". See the project-scope block above for why no tool takes a
// `project` parameter — and why the WRITE tools nonetheless take a `zone`.

server.tool(
    "monitor_list_zones",
    "List the zones the ANSWERING process knows about (GET /v1/zones). A zone is one whole monitor-core deployment — its own ClickHouse instance, own MariaDB, own URL and own API keys — and every project lives inside exactly one zone. Retired zones are excluded.\n\nWHAT COMES BACK DEPENDS ON WHO ANSWERS, AND NOTHING IN THE RESPONSE SAYS WHICH. The handler reads the registry table in the answering process's own MariaDB: pointed at the CONTROL PLANE that is the whole fleet (every zone), pointed at a ZONE it is normally just that zone's own row. So one row does not mean 'a single-zone fleet' and several rows do not mean 'you are on the control plane' — and NONE of the rows is necessarily the zone you are talking to.\n\nTo learn which zone THIS server talks to, read `_scope.zone` on any project-scoped read, or call monitor_health — its `zone` is the answering process's own identity. That is also the value the zone-binding write tools require and verify.\n\nRead-only here: zones are seeded out of band, their slugs are immutable and never reusable, and the writes live on the control-plane-only /admin surface.",
    {
        limit: z.number().optional().describe("Max zones to return, 1-500. Omit to get them all — this route asks for 500 by default rather than the usual 50. An out-of-range value is REFUSED with a 400, never clamped."),
        offset: z.number().optional().describe("Pagination offset. Must not be negative — a negative value is refused with a 400."),
    },
    async ({ limit, offset }) => {
        const res = await api("GET", "/v1/zones", { limit, offset });
        return { content: text(res) };
    }
);

server.tool(
    "monitor_list_projects",
    "List the active projects inside one zone (GET /v1/zones/{zone}/projects). A project is the tenant every event is filed under. Returns an OBJECT, not a bare array: {\"projects\": [...], \"default_project_slug\": \"...\"}. default_project_slug is a property of the INSTALL — the project an unset selector resolves to for a browser session — and is NOT necessarily the project this server reads: an API key answers only for the project named by its own api_keys row, which every other tool reports back in the `_scope` field. An unknown zone is a 404. Read-only — projects are seeded out of band and their slugs are immutable.",
    {
        zone: z.string().describe("Zone slug (path segment) — get it from monitor_list_zones. Required, because a project slug is unique only WITHIN its zone."),
        limit: z.number().optional().describe("Max projects to return, 1-500. Omit to get them all — this route asks for 500 by default rather than the usual 50. An out-of-range value is REFUSED with a 400, never clamped."),
        offset: z.number().optional().describe("Pagination offset. Must not be negative — a negative value is refused with a 400."),
    },
    async ({ zone, limit, offset }) => {
        const res = await api("GET", `/v1/zones/${encodeURIComponent(zone)}/projects`, { limit, offset });
        return { content: text(res) };
    }
);

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
//
// Issues are Monitor's error-tracking surface: errors grouped by fingerprint,
// carrying triage state, a timeline, linked pull requests and durable occurrence
// history. Status, comments and links live in MariaDB; the raw events they
// summarise live in ClickHouse under a 30-day TTL.

server.tool(
    "monitor_list_issues",
    "List error issues grouped by fingerprint. Issues aggregate repeated errors into a single trackable item with occurrence counts, triage status, linked PRs and a comment thread. This is the primary entry point for reviewing errors — start here, then monitor_get_issue for detail.",
    {
        status: z.enum(["unresolved", "in_progress", "resolved", "ignored"]).optional()
            .describe("Filter by status. 'unresolved' is also the backlog — it is the default for a newly-created issue. Omit for all."),
        service: z.string().optional().describe("Filter by service name"),
        assignee: z.string().optional()
            .describe("Filter by assignee user id, or the literal 'none' for unassigned issues"),
        has_pr: z.boolean().optional().describe("Only issues that do (or do not) have a linked pull request"),
        q: z.string().optional().describe("Substring search across name, message, title and path"),
        from: z.string().optional().describe("Only issues last seen at or after this time (RFC3339 or unix seconds)"),
        to: z.string().optional().describe("Only issues last seen at or before this time (RFC3339 or unix seconds)"),
        sort: z.enum(["last_seen", "first_seen", "occurrences"]).optional().describe("Sort column (default last_seen)"),
        order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)"),
        limit: z.number().optional().describe("Max issues to return (default 50, max 500)"),
        offset: z.number().optional().describe("Pagination offset (default 0)"),
    },
    async ({ status, service, assignee, has_pr, q, from, to, sort, order, limit, offset }) => {
        const params = {};
        if (status) params.status = status;
        if (service) params.service = service;
        if (assignee) params.assignee = assignee;
        if (has_pr !== undefined) params.has_pr = has_pr;
        if (q) params.q = q;
        if (from) params.from = from;
        if (to) params.to = to;
        if (sort) params.sort = sort;
        if (order) params.order = order;
        if (limit) params.limit = limit;
        if (offset) params.offset = offset;
        const res = await api("GET", "/v1/issues", params);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_get_issue",
    "Get full details of an issue: fingerprint, service, message, status, occurrence and regression counts, timestamps, linked pull requests, assignee, source repository, comment count, and a 30-day occurrence sparkline.",
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
    "Update an issue's triage state. Every field is optional — supply only what should change. Each changed field is recorded on the issue timeline against you, so a status change made here is attributed to this API key rather than landing anonymously.",
    {
        id: z.string().describe("The issue ID"),
        status: z.enum(["unresolved", "in_progress", "resolved", "ignored"]).optional()
            .describe("New status. Set 'in_progress' when starting work — a recurrence of the error will NOT reset it, whereas a recurrence of a 'resolved' issue reopens it as a regression."),
        priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("New priority"),
        title: z.string().optional().describe("Human-facing title, overriding the derived message"),
        assignee_user_id: z.number().optional().describe("Monitor user id to assign to"),
        clear_priority: z.boolean().optional().describe("Unset the priority"),
        clear_title: z.boolean().optional().describe("Unset the title"),
        clear_assignee: z.boolean().optional().describe("Unassign the issue"),
    },
    async ({ id, status, priority, title, assignee_user_id, clear_priority, clear_title, clear_assignee }) => {
        // The API distinguishes an explicit JSON null (clear the field) from an
        // omitted key (leave it alone), which a single optional parameter cannot
        // express — hence the separate clear_* flags mapping onto nulls.
        const body = {};
        if (status !== undefined) body.status = status;
        if (clear_priority) body.priority = null;
        else if (priority !== undefined) body.priority = priority;
        if (clear_title) body.title = null;
        else if (title !== undefined) body.title = title;
        if (clear_assignee) body.assignee_user_id = null;
        else if (assignee_user_id !== undefined) body.assignee_user_id = assignee_user_id;

        if (Object.keys(body).length === 0) {
            return { content: text({ error: "supply at least one field to update" }) };
        }
        const res = await api("PUT", `/v1/issues/${id}`, null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_get_issue_events",
    "Get individual event occurrences behind a grouped issue, with their full data payloads. Note that raw events expire after 30 days — use monitor_get_issue_history for older activity, which survives that expiry.",
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

server.tool(
    "monitor_get_issue_timeline",
    "Get an issue's activity feed, oldest first: comments, status changes, regressions, assignments, and pull-request events interleaved chronologically. Read this before commenting so you do not repeat what is already recorded.",
    {
        id: z.string().describe("The issue ID"),
        type: z.enum([
            "comment", "status_changed", "regressed", "assigned", "unassigned",
            "priority_changed", "title_changed", "pr_linked", "pr_unlinked",
            "pr_merged", "pr_closed", "pr_reopened",
        ]).optional().describe("Only entries of this kind"),
        include_deleted: z.boolean().optional().describe("Include soft-deleted comments (default false)"),
        limit: z.number().optional().describe("Max entries to return (default 50, max 500)"),
        offset: z.number().optional().describe("Pagination offset"),
    },
    async ({ id, type, include_deleted, limit, offset }) => {
        const params = {};
        if (type) params.type = type;
        if (include_deleted !== undefined) params.include_deleted = include_deleted;
        if (limit) params.limit = limit;
        if (offset) params.offset = offset;
        const res = await api("GET", `/v1/issues/${id}/timeline`, params);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_add_issue_comment",
    "Add a note to an issue's timeline. This is how you record what you found and what you did while working an issue — attributed to this API key, visible in the Monitor UI alongside human comments.\n\nPASS A dedupe_key whenever the note might be written more than once (a retried task, or the same investigation resumed in a later session). The write is then idempotent per key: an identical body is a no-op, a changed body edits the note in place. Without one, every call appends another comment. A stable key such as 'triage:<issue-id>' or 'run:<task-name>' is usually right.",
    {
        id: z.string().describe("The issue ID"),
        body: z.string().describe("The note. Markdown renders in the Monitor UI."),
        dedupe_key: z.string().optional()
            .describe("Idempotency key, unique per issue. Reposting with the same key updates that note instead of adding another."),
    },
    async ({ id, body, dedupe_key }) => {
        const payload = { body };
        if (dedupe_key) payload.dedupe_key = dedupe_key;
        const res = await api("POST", `/v1/issues/${id}/comments`, null, payload);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_edit_issue_comment",
    "Replace the body of an existing comment. Only comments are editable — a status change or a pull-request event is a historical fact, not a draft.",
    {
        id: z.string().describe("The issue ID"),
        comment_id: z.number().describe("The timeline entry ID of the comment"),
        body: z.string().describe("The replacement text"),
    },
    async ({ id, comment_id, body }) => {
        const res = await api("PATCH", `/v1/issues/${id}/comments/${comment_id}`, null, { body });
        return { content: text(res) };
    }
);

server.tool(
    "monitor_delete_issue_comment",
    "Soft-delete a comment. The row is kept so the timeline's shape and the audit trail survive; the comment simply stops being returned.",
    {
        id: z.string().describe("The issue ID"),
        comment_id: z.number().describe("The timeline entry ID of the comment"),
    },
    async ({ id, comment_id }) => {
        const res = await api("DELETE", `/v1/issues/${id}/comments/${comment_id}`);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_get_issue_history",
    "Get per-day occurrence counts for an issue. This reads a rollup with NO retention limit, so it still has shape for an issue whose raw events have expired — use it, not monitor_get_issue_events, to answer 'when did this start' or 'how often does it recur'.",
    {
        id: z.string().describe("The issue ID"),
        from: z.string().optional().describe("Window start (RFC3339 or unix seconds, default 30 days ago)"),
        to: z.string().optional().describe("Window end (RFC3339 or unix seconds, default now)"),
    },
    async ({ id, from, to }) => {
        const params = {};
        if (from) params.from = from;
        if (to) params.to = to;
        const res = await api("GET", `/v1/issues/${id}/history`, params);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_list_issue_links",
    "List the GitHub pull requests, issues and commits linked to an issue, with their cached state (open/closed/merged).",
    {
        id: z.string().describe("The issue ID"),
    },
    async ({ id }) => {
        const res = await api("GET", `/v1/issues/${id}/links`);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_link_issue_pr",
    "Link a GitHub pull request, issue or commit to a Monitor issue. Accepts a full URL, 'owner/repo#42', or a bare '#42' — the last resolved against the service's mapped repository (see monitor_list_service_repos), so a shorthand only works for a mapped service.\n\nLinking does not change issue status, and neither does the PR later merging: resolving stays a deliberate action.",
    {
        id: z.string().describe("The issue ID"),
        url: z.string().describe("A GitHub URL, owner/repo#number, or #number"),
    },
    async ({ id, url }) => {
        const res = await api("POST", `/v1/issues/${id}/links`, null, { url });
        return { content: text(res) };
    }
);

server.tool(
    "monitor_unlink_issue_pr",
    "Remove a link from an issue.",
    {
        id: z.string().describe("The issue ID"),
        link_id: z.number().describe("The link ID, from monitor_list_issue_links"),
    },
    async ({ id, link_id }) => {
        const res = await api("DELETE", `/v1/issues/${id}/links/${link_id}`);
        return { content: text(res) };
    }
);

// ==================== SERVICE REPOSITORIES ====================
//
// Monitor watches services across more than one GitHub org, and several service
// versions routinely share one repo (auth-service-v1 and -v2), so the mapping is
// explicit rather than derived from the service name.

server.tool(
    "monitor_list_service_repos",
    "List which source repository each reporting service is built from. A service missing from this list is unmapped: links to it still work, but only as full URLs — shorthand like '#42' cannot be resolved.",
    {},
    async () => {
        const res = await api("GET", "/v1/service-repos");
        return { content: text(res) };
    }
);

server.tool(
    "monitor_set_service_repo",
    "Map a service to its source repository. Several services may share one repository — that is the normal case for versioned services such as auth-service-v1 and auth-service-v2.\n\nThe mapping is a row in the answering zone's own MariaDB and serves only that zone's services, so `zone` is required and verified. Two zones can legitimately map the same service name to different repositories.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
        service: z.string().describe("The service name as it reports to Monitor"),
        repository: z.string().describe("'owner/repo', or any github.com URL naming the repository"),
        default_branch: z.string().optional().describe("Default branch, e.g. main"),
    },
    async ({ zone, service, repository, default_branch }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
        const body = { repository };
        if (default_branch) body.default_branch = default_branch;
        const res = await api("PUT", `/v1/service-repos/${encodeURIComponent(service)}`, null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_delete_service_repo",
    "Remove a service's repository mapping. The mapping lives in the answering zone only, so `zone` is required and verified — the same service name may be mapped in more than one zone, and deleting here does not touch the others.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
        service: z.string().describe("The service name"),
    },
    async ({ zone, service }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
        const res = await api("DELETE", `/v1/service-repos/${encodeURIComponent(service)}`);
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

// The sharpest edge in this file. monitor-core's apikeys.resolveProject binds
// the new key to a project in the zone of the ANSWERING PROCESS (env.ZoneSlug),
// and nothing in the request or the response names that zone — so asking the
// control plane for an "appleby" ingest key returns 200 with a key bound to a
// TRAILBLAZE project, and the service wired to it reports into the wrong tenant
// until a human notices an empty dashboard. `zone` is checked here, before the
// request, and is never sent.
server.tool(
    "monitor_create_api_key",
    "Create a new API key. The full key is only shown once, and this server masks it to its first two characters — the key will exist but you will not be able to read it here. Create keys in the Monitor UI when you need the value, or set MONITOR_ALLOW_SECRET_VALUES=1.\n\nThe key is bound to a project IN THE ZONE THIS SERVER TALKS TO, permanently and invisibly — the response does not name the zone. Hence the required `zone` argument, which is checked against this server's own zone and refuses the call on a mismatch.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
        name: z.string().describe("Human-readable name for the key (e.g. 'frontend-ingest', 'ci-admin')"),
        scope: z.enum(["admin", "ingest"]).describe("Key scope — 'ingest' for event ingestion only, 'admin' for full access"),
    },
    async ({ zone, name, scope }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
        const res = await api("POST", "/v1/api-keys", null, { name, scope });
        return { content: text(res) };
    }
);

// The one DESTRUCTIVE verb in the zone-binding set, and the reason it takes a
// `zone` even though key IDs are UUIDs. "A cross-zone ID would almost certainly
// 404" is a probability argument guarding an irreversible action: revoking an
// ingest key stops a tenant's services reporting, and the only symptom is a 401
// at the producer with nothing in Monitor to explain it. The consistency is also
// the point — create_api_key requiring a zone while delete_api_key did not would
// read as "deletes are zone-safe by construction", when they were only ever
// zone-safe by collision odds.
server.tool(
    "monitor_delete_api_key",
    "Delete an API key by ID. This immediately revokes access for anything using this key — an ingest key's services stop reporting, and the only symptom is a 401 at the producer with nothing in Monitor explaining it. Irreversible, so `zone` is required and verified: the key you are deleting lives in THIS server's zone whatever zone the ID was copied from.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
        id: z.string().describe("The API key ID to delete"),
    },
    async ({ zone, id }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
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
    "Create a new alert rule. Types: threshold (value crosses limit), absence (no events in window), rate_change (sudden spike/drop). Conditions: gt, lt, gte, lte, eq. Priority: P0 (critical), P1 (high), P2 (medium), P3 (low). query_filters is a JSON array of {field, operator, value} objects to scope the query (e.g. [{\"field\":\"service\",\"operator\":\"eq\",\"value\":\"auth-service-v2\"}]).\n\nThe rule is a row in the answering zone's own MariaDB and is evaluated only against that zone's events, so `zone` is required and verified.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
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
    async ({ zone, ...params }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
        // `zone` is destructured OUT, not spread into the body. It is this
        // server's assertion, not a field monitor-core reads — sending it would
        // be the silently-ignored parameter the project block above warns about.
        const body = { ...params };
        if (body.enabled === undefined) body.enabled = true;
        const res = await api("POST", "/v1/alert-rules", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_update_alert_rule",
    "Update an existing alert rule. This is a partial update: only fields you provide are sent, and any field you omit is left unchanged (including `enabled` — omit it to keep the rule's current on/off state; set it explicitly only when you intend to enable or disable the rule).\n\nRule IDs are unique only within a zone, so `zone` is required and verified: an ID copied from another zone's listing would otherwise edit whatever rule happens to carry it here.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
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
    async ({ zone, id, ...body }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
        // `zone` is destructured out with `id`: neither belongs in the body.
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
    "Delete an alert rule by ID. Rule IDs are unique only within a zone, so `zone` is required and verified — an ID copied from another zone's listing would otherwise delete whatever rule carries it here.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
        id: z.string().describe("The alert rule ID to delete"),
    },
    async ({ zone, id }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
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
    "Create a notification channel that alert rules can notify. Returns the created channel including its generated id. The `config` field is a JSON *string* whose shape depends on `type` (e.g. webhook: {\"url\":\"https://...\"}, slack: {\"webhook_url\":\"https://hooks.slack.com/...\"}, email: {\"to\":\"a@b.com\"}, pagerduty: {\"routing_key\":\"...\"}).\n\nThe channel is a row in the answering zone's own MariaDB and can only be wired into that zone's alert rules, so `zone` is required and verified.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
        name: z.string().describe("Human-readable channel name"),
        type: z.enum(["webhook", "slack", "email", "pagerduty"]).describe("Channel type"),
        config: z.string().optional().describe("Channel configuration as a JSON string (type-dependent). Defaults to empty."),
    },
    async ({ zone, name, type, config }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
        const body = { name, type };
        if (config !== undefined) body.config = config;
        const res = await api("POST", "/v1/notification-channels", null, body);
        return { content: text(res) };
    }
);

server.tool(
    "monitor_delete_notification_channel",
    "Delete a notification channel by ID. Alert rules referencing it will no longer notify through this channel. Channel IDs are unique only within a zone, so `zone` is required and verified — an ID copied from another zone's listing would otherwise silence alerts here.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
        id: z.string().describe("The notification channel ID to delete"),
    },
    async ({ zone, id }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
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
    "Create an SSO provider (POST /admin/sso-providers). slug and display_name are required; everything else is optional. kind is oidc (default) or oauth2 — OIDC providers set issuer_url (endpoints are discovered), OAuth2 providers set authorize_url/token_url/userinfo_url (and optionally introspect_url) explicitly. client_secret is PLAINTEXT and write-only: it is AES-256-GCM encrypted at rest and never echoed back (the response exposes only has_secret). Provide EITHER client_secret (encrypted at rest) OR client_secret_ref (a Keyring secret name), not both. scopes is a single space-separated string. ADMIN SESSION REQUIRED (SessionMiddleware + RequireAdmin, Bearer JWT only — X-Api-Key is rejected; set MONITOR_SESSION_TOKEN).\n\nProviders are rows in the answering zone's own MariaDB and govern who can sign in to THAT zone, so `zone` is required and verified — a provider created in the wrong zone appears on the wrong login page.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
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
    async ({ zone, ...body }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
        // `zone` is destructured out before the payload is built: it is checked,
        // never forwarded, and monitor-core has no field for it here.
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
    "Update an SSO provider by slug (PUT /admin/sso-providers/{slug}). PARTIAL update: only the fields you provide are sent and changed; omitted fields are left unchanged. The slug itself is the path key and cannot be changed here. client_secret is plaintext/write-only (re-encrypted at rest, never returned); provide client_secret OR client_secret_ref. ADMIN SESSION REQUIRED (SessionMiddleware + RequireAdmin, Bearer JWT only — X-Api-Key is rejected; set MONITOR_SESSION_TOKEN).\n\nA provider slug is unique only within a zone, so `zone` is required and verified — the same slug (\"google\") normally exists in every zone with different credentials.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
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
    async ({ zone, slug, ...body }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
        // `zone` and `slug` are both destructured out: slug is the path key and
        // zone is this server's assertion. Neither belongs in the body.
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
    "Delete an SSO provider by slug (DELETE /admin/sso-providers/{slug}). ADMIN SESSION REQUIRED (SessionMiddleware + RequireAdmin, Bearer JWT only — X-Api-Key is rejected; set MONITOR_SESSION_TOKEN).\n\nA provider slug is unique only within a zone, so `zone` is required and verified — deleting \"google\" here removes a sign-in route for THIS zone's users only, and doing it in the wrong zone locks out the wrong people.",
    {
        zone: z.string().describe(ZONE_PARAM_DESC),
        slug: z.string().describe("Slug of the provider to delete"),
    },
    async ({ zone, slug }) => {
        const refusal = await requireZone(zone);
        if (refusal) return refusal;
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
