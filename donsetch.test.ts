import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

// Pi Pocket's test helpers set up a temporary Pi install before anything from its src/ loads.
const pocketDir = process.env.PI_POCKET_REPO ?? join(homedir(), "pi-pocket");
const { cleanUp, lastText, modelTexts, newSession, openApp, owner, root, say, scriptedModel } = await import(
    pathToFileURL(join(pocketDir, "test", "helpers.ts")).href
);
const { fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");

const fakeDir = mkdtempSync(join(tmpdir(), "donsetch-pi-durable-"));
const fakeBinary = join(fakeDir, "fake-donsetch.mjs");

copyFileSync(join(import.meta.dirname, "scripts", "fake-donsetch.mjs"), fakeBinary);
chmodSync(fakeBinary, 0o755);

after(() => {
    delete process.env.DONSETCH_BINARY;
    rmSync(fakeDir, { recursive: true, force: true });
});
after(cleanUp);

function fetchModel() {
    return scriptedModel((context) => {
        const { role, text } = lastText(context as never);

        if (role === "toolResult") {
            return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
        }

        return fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com" })], {
            stopReason: "toolUse",
        });
    });
}

test("donsetch discovers web_fetch and returns its content", async () => {
    process.env.DONSETCH_BINARY = fakeBinary;

    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    copyFileSync(join(import.meta.dirname, "donsetch.ts"), join(dropIns, "donsetch.ts"));

    const app = await openApp(fetchModel());

    try {
        await app.setExtensionEnabled(owner(app), "donsetch.ts", true);
        const id = await newSession(app);

        await say(app, id, "Fetch https://example.com");

        const answer = (await modelTexts(app, id)).at(-1) ?? "";

        assert.match(answer, /URL: https:\/\/example\.com/);
        assert.match(answer, /This is test content\./);
    } finally {
        await app.close();
    }
});

test("loads the standard tools when the binary is missing", async () => {
    process.env.DONSETCH_BINARY = join(fakeDir, "missing-donsetch");

    const dataDir = join(root, "missing-data");
    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    copyFileSync(join(import.meta.dirname, "donsetch.ts"), join(dropIns, "donsetch.ts"));

    const app = await openApp(fetchModel(), dataDir);

    try {
        await app.setExtensionEnabled(owner(app), "donsetch.ts", true);
        const id = await newSession(app);

        await say(app, id, "Fetch https://example.com");

        const answer = (await modelTexts(app, id)).at(-1) ?? "";

        assert.match(answer, /DONSETCH_BINARY|not found|not an executable/);
    } finally {
        await app.close();
    }
});
