#!/usr/bin/env node
/**
 * Load the module without Pi Pocket and check the static tool surface.
 */
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const create = (await import("../donsetch.ts")).default;
const lock = JSON.parse(await readFile(new URL("../tools.lock.json", import.meta.url), "utf8"));
const agentDir = await mkdtemp(join(tmpdir(), "donsetch-agent-"));
const notices = [];
let dispose;

try {
    const extension = await create(
        {
            agentDir,
            notice: (level, message) => notices.push({ level, message }),
            text: { defang: (text) => text, quoted: (text) => text },
        },
        {
            onDispose: (run) => {
                dispose = run;
            },
        },
    );

    const names = extension.tools.map((tool) => tool.name);
    const expected = ["web_fetch", "web_search", "web_crawl", "web_screenshot"];
    const missing = expected.filter((name) => !names.includes(name));

    if (missing.length > 0) {
        throw new Error(`missing tools: ${missing.join(",")}`);
    }

    const extra = names.filter((name) => !expected.includes(name));

    if (extra.length > 0) {
        console.log(`new tools need review: ${extra.join(", ")}`);
    }

    const readOnly = Object.fromEntries(extension.tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));

    if (readOnly.web_fetch !== false) {
        throw new Error("web_fetch must not be read-only");
    }

    for (const name of ["web_search", "web_crawl", "web_screenshot"]) {
        if (readOnly[name] !== true) {
            throw new Error(`${name} must be read-only`);
        }
    }

    const fetch = extension.tools.find((tool) => tool.name === "web_fetch");

    if (fetch === undefined || !/Page actions/.test(fetch.description)) {
        throw new Error("web_fetch must warn about page actions");
    }

    if (fetch.replay !== "unsafe") {
        throw new Error("web_fetch must not replay after a restart");
    }

    for (const name of ["web_search", "web_crawl", "web_screenshot"]) {
        const tool = extension.tools.find((candidate) => candidate.name === name);

        if (tool?.replay !== "safe") {
            throw new Error(`${name} must be safe to replay`);
        }
    }

    console.log(`module loads with donsetch ${lock.donsetch}: ${names.join(", ")}`);
} finally {
    if (dispose !== undefined) {
        await dispose();
    }

    await rm(agentDir, { recursive: true, force: true });
}
