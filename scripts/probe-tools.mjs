#!/usr/bin/env node
/**
 * Print the tools that the installed donsetch MCP server offers. Use it after a donsetch update.
 */
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

const BINARY_NAMES = process.platform === "win32" ? ["donsetch.exe", "donsetch.cmd"] : ["donsetch"];
const PACKAGE_BINARY = process.platform === "win32" ? "donsetch.exe" : "donsetch";

async function executable(path) {
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

async function findBinary() {
    const override = process.env.DONSETCH_BINARY;

    if (override !== undefined && override !== "") {
        const path = resolve(override);

        if (!(await executable(path))) {
            throw new Error(`DONSETCH_BINARY points to ${path}, which is not an executable file.`);
        }

        return path;
    }

    const candidates = new Set();

    for (const folder of (process.env.PATH ?? "").split(delimiter)) {
        if (folder !== "") {
            for (const name of BINARY_NAMES) {
                candidates.add(join(folder, name));
            }
        }
    }

    candidates.add(join(process.cwd(), "node_modules", "donsetch", "binaries", PACKAGE_BINARY));
    candidates.add(join(homedir(), ".pi", "agent", "npm", "node_modules", "donsetch", "binaries", PACKAGE_BINARY));
    candidates.add(join(homedir(), ".cargo", "bin", PACKAGE_BINARY));

    for (const candidate of candidates) {
        if (await executable(candidate)) {
            return candidate;
        }
    }

    throw new Error("donsetch binary not found. Set DONSETCH_BINARY or install donsetch.");
}

const binary = await findBinary();
const transport = new StdioTransport({
    command: binary,
    args: ["mcp", "--supervised"],
    inheritEnv: true,
    stderr: "pipe",
    closeTimeoutMs: 2_000,
});
const client = new McpClient({
    name: "pi-pocket-donsetch-probe",
    version: "1.0.0",
    requestTimeoutMs: 15_000,
});

try {
    await client.connect(transport);
    const tools = await client.listTools();

    console.log(`binary: ${binary}`);
    console.log(`server: ${client.serverInfo?.name ?? "?"} ${client.serverInfo?.version ?? "?"}`);
    console.log(`protocol: ${client.protocolVersion ?? "?"}`);
    console.log(`tools: ${tools.length}`);

    for (const tool of tools) {
        console.log(`\n## ${tool.name}`);
        console.log(tool.description ?? "");
        console.log(JSON.stringify(tool.inputSchema, null, 2));
        console.log(`annotations: ${JSON.stringify(tool.annotations ?? {})}`);
    }
} finally {
    await client.close().catch(() => {});
}
