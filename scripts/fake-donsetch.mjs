#!/usr/bin/env node
/**
 * A tiny MCP server for the test. It speaks the same stdio protocol as `donsetch mcp`, without a network.
 */
import { createInterface } from "node:readline";

const tools = [
    {
        name: "web_fetch",
        description: "Fetch a URL as markdown.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string" },
                deadline_ms: { type: "number" },
            },
            required: ["url"],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "web_search",
        description: "Search the web.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string" },
            },
            required: ["query"],
        },
        annotations: { readOnlyHint: true },
    },
];

const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
};

const reply = (id, result) => {
    send({ jsonrpc: "2.0", id, result });
};

const fail = (id, code, message) => {
    send({ jsonrpc: "2.0", id, error: { code, message } });
};

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
    const text = line.trim();

    if (text === "") {
        return;
    }

    let message;

    try {
        message = JSON.parse(text);
    } catch {
        return;
    }

    if (message.id === undefined) {
        // notifications/initialized, notifications/cancelled, and other notices need no answer.
        return;
    }

    switch (message.method) {
        case "initialize":
            reply(message.id, {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-donsetch", version: "4.10.1" },
            });
            break;

        case "tools/list":
            reply(message.id, { tools });
            break;

        case "tools/call": {
            const name = message.params?.name;
            const args = message.params?.arguments ?? {};

            if (name === "web_fetch") {
                reply(message.id, {
                    content: [
                        {
                            type: "text",
                            text: `# Fetched\n\nURL: ${String(args.url)}\n\nThis is test content.`,
                        },
                    ],
                });
            } else if (name === "web_search") {
                reply(message.id, {
                    content: [{ type: "text", text: `1. **Result** — ${String(args.query)}` }],
                });
            } else {
                fail(message.id, -32602, `unknown tool: ${String(name)}`);
            }
            break;
        }

        default:
            fail(message.id, -32601, `unknown method: ${String(message.method)}`);
    }
});

lines.on("close", () => {
    process.exit(0);
});
