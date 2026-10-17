# donsetch for Pi Pocket

> AI-generated notice: An AI assistant generated the code and documentation in this repository. Review them before you use or share them.

A Pi Pocket drop-in that gives Pi DonSeTch's four web tools.

| Tool | What it does | Read-only |
|---|---|---|
| `web_fetch` | Read a URL as source markdown, with PDF, focus, section, and pagination support. | No. Page actions can change remote state. |
| `web_search` | Search the web without API keys. | Yes. |
| `web_crawl` | Crawl a site with budgets, resume tokens, and stop reasons. | Yes. |
| `web_screenshot` | Capture a rendered PNG. | Yes. |

The addon talks to donsetch over MCP. It includes its own small MCP stdio client and imports only Pi Pocket's `@earendil-works/pi-ai` and `@earendil-works/pi-durable` packages. The four tools are defined in `donsetch.ts`. The binary handles the calls.

## Requirements

- Pi Pocket 0.14.0 or later.
- A `donsetch` binary. The addon finds it in this order:
  1. `DONSETCH_BINARY`
  2. `PATH`
  3. the Pi agent npm package (`<agentDir>/npm/node_modules/donsetch/binaries/donsetch`)
  4. `~/.cargo/bin/donsetch`

Install the binary with one of these:

```bash
pi install npm:donsetch
npm install -g donsetch
```

If the binary is missing, the addon still loads the four tools. A call explains what is missing. Install the binary, then reload the extension.

## Install

1. Copy `donsetch.ts` to `~/.pi-pocket/extensions/`.
2. Open Menu → Extensions and turn on **donsetch** under **Yours**.
3. Start a session and ask: `Fetch https://example.com`.

The addon starts one MCP session for each Pi Pocket conversation. This keeps `S1`/`L12` handles and `since_last` inside the conversation that made them. The addon keeps up to 4 sessions. A fifth conversation closes the least recently used idle session. If all are busy, it opens another. Idle sessions close after 30 minutes.

## Updates

The four tools are fixed in the addon. Donsetch behavior updates when you update the binary. New tool names, descriptions, schemas, or read-only flags need an addon update.

- Update the binary with the Pi package, `donsetch update`, or npm.
- On the first tool call, the addon compares the binary version with the version it was built for. If they differ, it shows a notice. No network call is made for this check.
- The gallery shows "update available" when a new addon version is in the index. The owner reviews the diff and applies it. The gallery never auto-updates.
- The repo has a daily sync workflow. It regenerates the static tools from the latest npm release, tests the module, and opens a PR. A person reviews the PR.
- Run `npm run check-tools` to compare the installed binary with the static tools.
- Run `npm run probe` to print the current tool list and schemas.
- Run `npm run check-upstream` to compare the npm package's `pi-extension.ts` bridge assumptions with `upstream.lock.json`.

## Configuration

| Variable | Effect |
|---|---|
| `DONSETCH_BINARY` | Path to the donsetch executable. An invalid path is an error; the addon does not fall back. |
| `DONSETCH_DEBUG=1` or `DEBUG=1` | Forward donsetch stderr to the Pi Pocket server log. |

The addon gives the child process a limited environment. It includes `PATH`, `HOME`, `XDG_*`, `LC_*`, `LANG`, proxy variables, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `SSL_CERT_*`, `FONTCONFIG_*`, `CHROME_PATH`, `PLAYWRIGHT_BROWSERS_PATH`, and variables that start with `DONSETCH_` or `DONSEEK_`. It does not pass provider keys or unrelated secrets.

## Limits

- One call waits for the tool's own budget plus 20 seconds of slack, capped at 620 seconds.
- `web_fetch` and the other tools with `deadline_ms`, and `web_crawl` with `deadline_s`, use the budget in the call.
- `web_fetch` is not read-only. Plan mode blocks it. It can click, type, or press and can change remote state.
- The other three tools are read-only.
- A dropped connection is retried once only for the read-only tools. `web_fetch` is not retried. A crash does not replay it.
- Cancelling the tool call sends the cancellation to the MCP server.

## Security

- The addon runs the local `donsetch` binary with the Pi Pocket server's rights.
- The child process gets a limited environment. Provider keys and unrelated secrets stay out.
- Web page text and images go to the model as tool results. The addon fences text with `host.text.defang` and adds a data notice. Images get the text notice. The model is told the content is data, not instructions.
- `web_search` sends queries to Google, Bing, Brave, DuckDuckGo, Yahoo, Mojeek, GitHub, Wikipedia, Hacker News, Semantic Scholar, arXiv, Stack Exchange, MDN, and Google News. Donsetch can change this list.
- `web_fetch` page actions can change state on the remote page. Use them only when the request needs them.
- The addon does not read provider keys, cookies, or other credentials. Donsetch can use its own saved login cookies.
- Review `donsetch.ts` before you turn it on. A drop-in runs with the owner's rights.

## Development

The project uses the packages that Pi Pocket already installed. Link them for the typecheck:

```bash
export PI_POCKET_REPO=/path/to/pi-pocket
ln -sfn "$PI_POCKET_REPO/node_modules" node_modules
ln -sfn "$PI_POCKET_REPO/types/pocket.d.ts" _pocket.d.ts
```

Then:

```bash
PI_POCKET_REPO="$PI_POCKET_REPO" npm test   # temp Pi Pocket data, no network
npm run check
npm run generate-tools                       # real binary, writes the static block
npm run check-tools                          # compares the binary with the block
npm run check-module                         # loads the module without Pi Pocket
npm run probe                                # real binary, lists tools
npm run check-upstream
```

The test defaults to `~/pi-pocket` when `PI_POCKET_REPO` is not set. It imports Pi Pocket's helpers and uses a temporary data folder.

`scripts/generate-tools.mjs` writes the block between `// BEGIN GENERATED TOOLS` and `// END GENERATED TOOLS`, plus `tools.lock.json`. The sync workflow runs the generator and opens a PR when the tools change.

## License

MIT. See `LICENSE`.

DonSeTch is AGPL-3.0 and is a separate program. This addon does not include DonSeTch code; it talks to the binary over MCP.
