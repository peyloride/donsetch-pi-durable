#!/usr/bin/env node
/**
 * Compare the bridge assumptions in the latest donsetch npm package with upstream.lock.json.
 *
 * Exit 0: the bridge is unchanged, even if the package version or source hash changed.
 * Exit 1: a bridge constant, the launch command, or the protocol version changed. Review the addon.
 * Exit 2: the check could not run.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registry = "https://registry.npmjs.org/donsetch/latest";
const lock = JSON.parse(await readFile(new URL("../upstream.lock.json", import.meta.url), "utf8"));

function constant(source, name) {
    const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+)`));

    return match?.[1]?.trim() ?? null;
}

function report(label, value, locked) {
    const same = value === locked;

    console.log(`${same ? "=" : "!"} ${label}: ${value ?? "missing"}${same ? "" : ` (locked ${locked ?? "missing"})`}`);

    return same;
}

async function main() {
    const response = await fetch(registry);

    if (!response.ok) {
        throw new Error(`npm registry answered ${response.status}`);
    }

    const latest = await response.json();
    const tarballResponse = await fetch(latest.dist.tarball);

    if (!tarballResponse.ok) {
        throw new Error(`npm tarball answered ${tarballResponse.status}`);
    }

    const folder = await mkdtemp(join(tmpdir(), "donsetch-upstream-"));

    try {
        const tarball = join(folder, "donsetch.tgz");

        await writeFile(tarball, Buffer.from(await tarballResponse.arrayBuffer()));
        execFileSync("tar", ["-xzf", tarball, "-C", folder, lock.source.path], { stdio: "ignore" });

        const source = await readFile(join(folder, lock.source.path), "utf8");
        const hash = createHash("sha256").update(source).digest("hex");
        const bridge = {
            command: /\[\s*"mcp"\s*,\s*"--supervised"\s*\]/.test(source) ? "mcp --supervised" : null,
            protocolVersion: source.match(/protocolVersion:\s*"([^"]+)"/)?.[1] ?? null,
            initTimeoutMs: constant(source, "INIT_TIMEOUT_MS"),
            callTimeoutMs: constant(source, "CALL_TIMEOUT_MS"),
            deadlineSlackMs: constant(source, "CALL_DEADLINE_SLACK_MS"),
            maxCallTimeoutMs: constant(source, "MAX_CALL_TIMEOUT_MS"),
        };

        console.log(`donsetch npm: ${latest.version} (locked ${lock.npm.version})`);
        console.log(`source sha256: ${hash} (locked ${lock.source.sha256})`);
        console.log("bridge:");

        let changed = false;

        for (const [key, value] of Object.entries(bridge)) {
            changed = !report(key, value, lock.bridge[key]) || changed;
        }

        if (changed) {
            console.log(
                "\nThe bridge changed. Read the new pi-extension.ts, run `npm run probe`, update the addon if needed, then update upstream.lock.json.",
            );
            process.exitCode = 1;

            return;
        }

        console.log("\nThe bridge assumptions still match. A new version or source hash alone is not a failure.");
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(`upstream check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
});
