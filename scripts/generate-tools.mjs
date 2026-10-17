#!/usr/bin/env node
/**
 * Read the tools from the installed donsetch MCP server and write them into donsetch.ts.
 *
 *   node scripts/generate-tools.mjs          write the block and tools.lock.json
 *   node scripts/generate-tools.mjs --check  compare the binary with the lock; exit 1 when different
 */
import { createHash } from "node:crypto";
import { access, constants, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

const BINARY_NAMES = process.platform === "win32" ? ["donsetch.exe", "donsetch.cmd"] : ["donsetch"];
const PACKAGE_BINARY = process.platform === "win32" ? "donsetch.exe" : "donsetch";
const READ_ONLY = new Set(["web_search", "web_crawl", "web_screenshot"]);
const SOURCE = new URL("../donsetch.ts", import.meta.url);
const LOCK = new URL("../tools.lock.json", import.meta.url);
const CHECK = process.argv.includes("--check");

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

function toolHash(tool) {
    return createHash("sha256").update(JSON.stringify(tool)).digest("hex");
}

function staticTool(tool) {
    const description = tool.description ?? tool.title ?? tool.name;

    return {
        name: tool.name,
        description:
            tool.name === "web_fetch"
                ? `${description} Page actions can click, type, or press and may change remote state.`
                : description,
        inputSchema: tool.inputSchema,
        readOnly: READ_ONLY.has(tool.name),
    };
}

async function readServerTools() {
    const binary = await findBinary();
    const transport = new StdioTransport({
        command: binary,
        args: ["mcp", "--supervised"],
        inheritEnv: true,
        stderr: "pipe",
        closeTimeoutMs: 2_000,
    });
    const client = new McpClient({
        name: "donsetch-tools-generator",
        version: "1.0.0",
        requestTimeoutMs: 30_000,
    });

    try {
        await client.connect(transport);

        const tools = await client.listTools();

        return {
            binary,
            version: client.serverInfo?.version ?? "unknown",
            tools: tools.map(staticTool),
            stderr: transport.stderr,
        };
    } finally {
        await client.close().catch(() => {});
    }
}

async function lockOf(tools, version) {
    const entries = {};

    for (const tool of tools) {
        entries[tool.name] = { sha256: toolHash(tool), readOnly: tool.readOnly };
    }

    return { donsetch: version, tools: entries };
}

async function check() {
    let current;

    try {
        current = await readServerTools();
    } catch (error) {
        console.error(`could not read donsetch tools: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;

        return;
    }

    const next = await lockOf(current.tools, current.version);
    let locked;

    try {
        locked = JSON.parse(await readFile(LOCK, "utf8"));
    } catch {
        console.error("tools.lock.json is missing. Run `node scripts/generate-tools.mjs`.");
        process.exitCode = 2;

        return;
    }

    let changed = locked.donsetch !== next.donsetch;
    const names = new Set([...Object.keys(locked.tools ?? {}), ...Object.keys(next.tools)]);

    console.log(`donsetch: ${next.donsetch} (locked ${locked.donsetch})`);

    for (const name of [...names].sort()) {
        const before = locked.tools?.[name];
        const after = next.tools[name];
        const same = before !== undefined && after !== undefined && before.sha256 === after.sha256 && before.readOnly === after.readOnly;

        console.log(`${same ? "=" : "!"} ${name}`);

        if (!same) {
            changed = true;
        }
    }

    if (changed) {
        console.log("\nThe static tools differ. Run `node scripts/generate-tools.mjs` and review the diff.");
        process.exitCode = 1;

        return;
    }

    console.log("\nThe static tools match the installed donsetch.");
}

async function write() {
    let current;

    try {
        current = await readServerTools();
    } catch (error) {
        console.error(`could not read donsetch tools: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;

        return;
    }

    if (current.version === "unknown") {
        console.error("donsetch did not report a version.");
        process.exitCode = 2;

        return;
    }

    const source = await readFile(SOURCE, "utf8");
    const start = "// BEGIN GENERATED TOOLS";
    const end = "// END GENERATED TOOLS";

    if (!source.includes(start) || !source.includes(end)) {
        console.error(`markers ${start} and ${end} are missing from donsetch.ts`);
        process.exitCode = 2;

        return;
    }

    const block = `${start}
const TOOLS_VERSION = ${JSON.stringify(current.version)};
const TOOLS: StaticTool[] = ${JSON.stringify(current.tools, null, 4)};
${end}`;
    const next = source.replace(/\/\/ BEGIN GENERATED TOOLS[\s\S]*?\/\/ END GENERATED TOOLS/, block);

    await writeFile(SOURCE, next);
    await writeFile(LOCK, `${JSON.stringify(await lockOf(current.tools, current.version), null, 4)}\n`);

    console.log(`wrote donsetch ${current.version} with ${current.tools.length} tools from ${current.binary}`);
}

if (CHECK) {
    await check();
} else {
    await write();
}
