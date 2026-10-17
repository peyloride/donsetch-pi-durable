/**
 * DonSeTch web fetch, search, crawl, and screenshot tools for Pi Pocket, through the local donsetch MCP binary.
 *
 * This is an independent MIT-licensed bridge. DonSeTch itself is AGPL-3.0 and runs as a separate program. The MCP
 * client and transports come from the MIT-licensed @earendil-works/pi-mcp package that Pi Pocket ships.
 */
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import type { CallToolResult, McpClient, StdioTransport, Tool as McpTool } from "@earendil-works/pi-mcp";
import type { Host, Web } from "./_pocket.d.ts";

/** The version of Pi Pocket's extension API that this module is written for. */
export const pocketApi = 1;

const CLIENT_NAME = "pi-pocket-donsetch";
const CLIENT_VERSION = "1.0.0";
const INIT_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const CALL_DEADLINE_SLACK_MS = 20_000;
const MAX_CALL_TIMEOUT_MS = 620_000;
const MAX_SESSIONS = 4;
const IDLE_MS = 30 * 60_000;
const SWEEP_MS = 60_000;
const BINARY_NAMES = process.platform === "win32" ? ["donsetch.exe", "donsetch.cmd"] : ["donsetch"];
const PACKAGE_BINARY = process.platform === "win32" ? "donsetch.exe" : "donsetch";
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

type Mcp = typeof import("@earendil-works/pi-mcp");

interface Session {
    readonly client: McpClient;
    readonly transport: StdioTransport;
    lastUsed: number;
    busy: number;
    closed: boolean;
}

/** A positive number from a tool argument, which some models send as text. */
function positiveNumber(value: unknown): number | undefined {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

    return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** Time to wait for one call, from the budget the tool's own schema accepts. */
function callTimeoutFor(tool: McpTool, args: Record<string, unknown>): number {
    const properties = tool.inputSchema.properties;
    const accepts = (name: string) =>
        properties !== null &&
        typeof properties === "object" &&
        !Array.isArray(properties) &&
        name in properties;

    if (accepts("deadline_ms")) {
        const budget = positiveNumber(args.deadline_ms);

        return budget === undefined
            ? DEFAULT_CALL_TIMEOUT_MS
            : Math.min(budget + CALL_DEADLINE_SLACK_MS, MAX_CALL_TIMEOUT_MS);
    }

    if (accepts("deadline_s")) {
        const budget = positiveNumber(args.deadline_s);

        return budget === undefined
            ? DEFAULT_CALL_TIMEOUT_MS
            : Math.min(budget * 1000 + CALL_DEADLINE_SLACK_MS, MAX_CALL_TIMEOUT_MS);
    }

    return DEFAULT_CALL_TIMEOUT_MS;
}

/** One sentence from the server's stderr, for a failure. */
function stderrHint(transport: StdioTransport | undefined): string {
    const text = transport?.stderr.trim();

    if (!text) {
        return "";
    }

    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    const fatal = lines.filter((line) => /fatal|panic|crash|SIGSEGV|abort|OOM|out of memory/i.test(line));
    const picked = fatal.length > 0 ? fatal : lines.slice(-2);

    return picked.length === 0 ? "" : ` stderr: ${picked.slice(-3).join(" | ").slice(0, 500)}`;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function aborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

async function executable(path: string): Promise<boolean> {
    try {
        const info = await stat(path);

        if (!info.isFile()) {
            return false;
        }

        await access(path, constants.X_OK);

        return true;
    } catch {
        return false;
    }
}

/** The local donsetch binary, in the order that keeps an explicit choice first. */
async function resolveBinary(host: Host): Promise<string> {
    const override = process.env.DONSETCH_BINARY;

    if (override !== undefined && override !== "") {
        const path = resolve(override);

        if (!(await executable(path))) {
            throw new Error(
                `DONSETCH_BINARY points to ${path}, which is not an executable file. Unset it or fix the path.`,
            );
        }

        return path;
    }

    const candidates = new Set<string>();

    for (const folder of (process.env.PATH ?? "").split(delimiter)) {
        if (folder !== "") {
            for (const name of BINARY_NAMES) {
                candidates.add(join(folder, name));
            }
        }
    }

    // Pi installs its npm packages here. The donsetch package keeps the binary under binaries/.
    candidates.add(join(host.agentDir, "npm", "node_modules", "donsetch", "binaries", PACKAGE_BINARY));
    candidates.add(join(homedir(), ".cargo", "bin", PACKAGE_BINARY));

    for (const candidate of candidates) {
        if (await executable(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        "donsetch binary not found. Install it with `npm install -g donsetch` or `pi install npm:donsetch`, " +
            "or set DONSETCH_BINARY to its path.",
    );
}

/** Normalize the server schema for providers that require an object with properties. */
function toolSchema(tool: McpTool): TSchema {
    const input = tool.inputSchema;
    const properties = input.properties;

    return {
        ...input,
        type: "object",
        properties: properties !== null && typeof properties === "object" && !Array.isArray(properties) ? properties : {},
    } as TSchema;
}

function isReadOnly(tool: McpTool): boolean {
    return tool.annotations?.readOnlyHint ?? true;
}

/**
 * The four standard tools, for a load without the binary, such as the gallery check. The model gets the exact schemas
 * from the binary when it is there. These schemas stay permissive so a later donsetch argument still passes.
 */
const FALLBACK_TOOLS: McpTool[] = [
    {
        name: "web_fetch",
        description: "Read a URL as source markdown with the local donsetch binary.",
        inputSchema: {
            type: "object",
            properties: {
                url: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
                deadline_ms: { type: "integer" },
            },
            required: ["url"],
            additionalProperties: true,
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "web_search",
        description: "Search the web with the local donsetch binary.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string" },
                intent: { type: "string" },
                max_results: { type: "integer" },
                deadline_ms: { type: "integer" },
            },
            required: ["query"],
            additionalProperties: true,
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "web_crawl",
        description: "Crawl a site with the local donsetch binary.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string" },
                resume: { type: "string" },
                focus: { type: "string" },
                max_pages: { type: "integer" },
                deadline_s: { type: "integer" },
            },
            required: [],
            additionalProperties: true,
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "web_screenshot",
        description: "Capture a URL as a PNG with the local donsetch binary.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string" },
                full_page: { type: "boolean" },
                wait_ms: { type: "integer" },
                deadline_ms: { type: "integer" },
            },
            required: ["url"],
            additionalProperties: true,
        },
        annotations: { readOnlyHint: true },
    },
];

export default async function createDonsetch(host: Host, web: Web) {
    let mcp: Mcp;

    try {
        mcp = await import("@earendil-works/pi-mcp");
    } catch (error) {
        throw new Error(
            "donsetch needs @earendil-works/pi-mcp, which Pi Pocket ships. " + describeError(error),
        );
    }

    let binary: string | undefined;
    let binaryProblem: string | undefined;

    try {
        binary = await resolveBinary(host);
    } catch (error) {
        binaryProblem = describeError(error);
    }

    const binaryAtLoad =
        binary === undefined
            ? ""
            : await stat(binary).then(
                  (info) => `${info.mtimeMs}:${info.size}`,
                  () => "",
              );
    const sessions = new Map<ConversationId, Session>();
    const opening = new Map<ConversationId, Promise<Session>>();
    const live = new Set<Session>();
    let disposed = false;
    let staleNoticed = false;
    let probe: Session | undefined;

    const forwardStderr = (chunk: string) => {
        if (process.env.DONSETCH_DEBUG !== undefined || process.env.DEBUG !== undefined) {
            process.stderr.write(chunk);
        }
    };

    async function openSession(conversationId?: ConversationId, timeoutMs = INIT_TIMEOUT_MS): Promise<Session> {
        const command = binary;

        if (command === undefined) {
            throw new Error(binaryProblem ?? "donsetch binary not found.");
        }

        const transport = new mcp.StdioTransport({
            command,
            args: ["mcp", "--supervised"],
            inheritEnv: true,
            stderr: "pipe",
            onStderr: forwardStderr,
            closeTimeoutMs: 2_000,
        });
        const client = new mcp.McpClient({
            name: CLIENT_NAME,
            title: "Pi Pocket DonSeTch",
            version: CLIENT_VERSION,
            requestTimeoutMs: timeoutMs,
        });
        const session: Session = { client, transport, lastUsed: Date.now(), busy: 0, closed: false };
        live.add(session);

        client.onClose(() => {
            session.closed = true;
            live.delete(session);

            if (conversationId !== undefined && sessions.get(conversationId) === session) {
                sessions.delete(conversationId);
            }
        });

        try {
            await client.connect(transport);
        } catch (error) {
            await closeSession(session);
            throw new Error(`donsetch failed to start (${command}): ${describeError(error)}${stderrHint(transport)}`);
        }

        return session;
    }

    async function closeSession(session: Session): Promise<void> {
        session.closed = true;
        live.delete(session);

        try {
            await session.client.close();
        } catch {
            // Closing is best effort: the transport already has its own kill timeout.
        }
    }

    async function sweep(): Promise<void> {
        const now = Date.now();

        for (const [id, session] of [...sessions]) {
            if (session.busy === 0 && now - session.lastUsed > IDLE_MS) {
                sessions.delete(id);
                void closeSession(session);
            }
        }
    }

    const timer = setInterval(() => {
        void sweep();
    }, SWEEP_MS);
    timer.unref?.();

    web.onDispose(async () => {
        disposed = true;
        clearInterval(timer);
        const all = [...live];

        sessions.clear();
        probe = undefined;

        await Promise.allSettled(all.map((session) => closeSession(session)));
    });

    let discovered: McpTool[] = [];
    let serverVersion = "unknown";
    let probeProblem: string | undefined;

    if (binary !== undefined) {
        try {
            probe = await openSession(undefined, PROBE_TIMEOUT_MS);
            discovered = await probe.client.listTools();
            serverVersion = probe.client.serverInfo?.version ?? "unknown";

            if (discovered.length === 0) {
                throw new Error("donsetch returned no tools.");
            }
        } catch (error) {
            probeProblem = `${describeError(error)}${stderrHint(probe?.transport)}`;
        } finally {
            if (probe !== undefined) {
                const current = probe;
                probe = undefined;
                await closeSession(current);
            }
        }
    }

    if (disposed) {
        // The module went while it was loading. Pi Pocket installs nothing for it.
        return defineExtension({ name: "donsetch", tools: [] });
    }

    const usableTools = discovered.length > 0 ? discovered : FALLBACK_TOOLS;

    if (discovered.length === 0) {
        const reason = binaryProblem ?? probeProblem ?? "donsetch returned no tools.";

        console.warn(`[donsetch] using the four standard tools: ${reason}`);
        host.notice(
            "warning",
            "donsetch is not ready. Run `donsetch doctor`, then reload the extension.",
        );
    } else {
        console.info(`[donsetch] ${serverVersion}: ${discovered.map((tool) => tool.name).join(", ")}`);
    }

    async function evictIfNeeded(keep: ConversationId): Promise<void> {
        if (sessions.size <= MAX_SESSIONS) {
            return;
        }

        const idle = [...sessions.entries()]
            .filter(([id, session]) => id !== keep && session.busy === 0 && !session.closed)
            .sort((left, right) => left[1].lastUsed - right[1].lastUsed);

        for (const [id, session] of idle) {
            if (sessions.size <= MAX_SESSIONS) {
                break;
            }

            sessions.delete(id);
            await closeSession(session);
        }
    }

    async function sessionFor(conversationId: ConversationId): Promise<Session> {
        if (disposed) {
            throw new Error("donsetch is off.");
        }

        const existing = sessions.get(conversationId);

        if (existing !== undefined && !existing.closed && existing.client.connectionState === "connected") {
            return existing;
        }

        if (existing !== undefined) {
            sessions.delete(conversationId);
            void closeSession(existing);
        }

        const pending = opening.get(conversationId);

        if (pending !== undefined) {
            return pending;
        }

        const promise = (async () => {
            const session = await openSession(conversationId);

            if (disposed) {
                await closeSession(session);
                throw new Error("donsetch is off.");
            }

            sessions.set(conversationId, session);
            await evictIfNeeded(conversationId);

            return session;
        })().finally(() => {
            opening.delete(conversationId);
        });

        opening.set(conversationId, promise);

        return promise;
    }

    async function callTool(
        conversationId: ConversationId,
        tool: McpTool,
        args: Record<string, unknown>,
        signal: AbortSignal | undefined,
    ): Promise<CallToolResult> {
        let lastError: unknown;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            const session = await sessionFor(conversationId);

            if (aborted(signal)) {
                throw new Error("Aborted");
            }

            session.busy += 1;
            session.lastUsed = Date.now();

            if (!staleNoticed && binaryAtLoad !== "" && binary !== undefined) {
                const now = await stat(binary).then(
                    (info) => `${info.mtimeMs}:${info.size}`,
                    () => "",
                );

                if (now !== "" && now !== binaryAtLoad) {
                    staleNoticed = true;
                    host.notice(
                        "info",
                        "donsetch changed on disk. Reload the extension to pick up new tools.",
                        conversationId,
                    );
                }
            }

            try {
                return await session.client.callTool(tool.name, args, {
                    signal,
                    timeoutMs: callTimeoutFor(tool, args),
                });
            } catch (error) {
                lastError = error;
                const connectionLost =
                    error instanceof mcp.McpConnectionClosedError ||
                    /closed|disconnected|EPIPE|not running/i.test(describeError(error));

                if (connectionLost) {
                    session.closed = true;

                    if (sessions.get(conversationId) === session) {
                        sessions.delete(conversationId);
                    }

                    void closeSession(session);

                    if (attempt === 0 && !aborted(signal)) {
                        continue;
                    }
                }

                throw error;
            } finally {
                session.busy = Math.max(0, session.busy - 1);
                session.lastUsed = Date.now();
            }
        }

        throw lastError ?? new Error("donsetch call failed");
    }

    const installedTools = usableTools.flatMap((mcpTool) => {
        const name = mcpTool.name;

        if (!TOOL_NAME.test(name)) {
            console.warn(`[donsetch] skipped a tool with an invalid name: ${name}`);

            return [];
        }

        const readOnly = isReadOnly(mcpTool);
        const tool = defineTool({
            name,
            description: mcpTool.description ?? mcpTool.title ?? name,
            parameters: Type.Unsafe<Record<string, unknown>>(toolSchema(mcpTool)),
            replay: readOnly ? "safe" : "unsafe",
            execute: async (args, api, context) => {
                const input = (args ?? {}) as Record<string, unknown>;

                if (aborted(context.abortSignal)) {
                    return {
                        content: [{ type: "text" as const, text: "Cancelled" }],
                        details: { mcpTool: name, cancelled: true, chars: 0, isError: false },
                    };
                }

                try {
                    const result = await callTool(api.conversationId, mcpTool, input, context.abortSignal);
                    const content = mcp.toLlmContent(result);
                    const blocks =
                        content.length > 0
                            ? content
                            : [{ type: "text" as const, text: "donsetch returned no content." }];
                    const chars = blocks.reduce(
                        (total, block) => total + (block.type === "text" ? block.text.length : 0),
                        0,
                    );

                    return {
                        content: blocks,
                        ...(result.isError === true ? { isError: true } : {}),
                        details: { mcpTool: name, cancelled: false, chars, isError: result.isError === true },
                    };
                } catch (error) {
                    if (error instanceof mcp.McpAbortError || aborted(context.abortSignal)) {
                        return {
                            content: [{ type: "text" as const, text: "Cancelled" }],
                            details: { mcpTool: name, cancelled: true, chars: 0, isError: false },
                        };
                    }

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `donsetch ${name} failed: ${describeError(error)}`,
                            },
                        ],
                        isError: true,
                        details: { mcpTool: name, cancelled: false, chars: 0, isError: true },
                    };
                }
            },
        });

        return [Object.assign(tool, { annotations: { readOnlyHint: readOnly } })];
    });

    return defineExtension({ name: "donsetch", tools: installedTools });
}
