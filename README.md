# donsetch for Pi Pocket

A Pi Pocket drop-in that gives Pi DonSeTch's four web tools:

| Tool | What it does |
|---|---|
| `web_fetch` | Read a URL as source markdown, with PDF, focus, section, and pagination support. |
| `web_search` | Search the web without API keys. |
| `web_crawl` | Crawl a site with budgets, resume tokens, and honest stop reasons. |
| `web_screenshot` | Capture a rendered PNG. |

The addon is a thin MCP bridge. It discovers the tools from the installed binary at load, so new tools and arguments appear after a reload without changing this file.

## Requirements

- Pi Pocket 0.14.0 or later.
- A `donsetch` binary. The addon finds it in this order:
  1. `DONSETCH_BINARY`
  2. `PATH`
  3. the Pi agent npm package (`<agentDir>/npm/node_modules/donsetch/binaries/donsetch`)
  4. `~/.cargo/bin/donsetch`
- `@earendil-works/pi-mcp` 1.1.x. Pi Pocket ships it with `@earendil-works/pi-coding-agent`.

Install the binary with one of these:

```bash
pi install npm:donsetch
npm install -g donsetch
```

If the binary is missing, the addon still loads the four standard tools. A tool call then explains what is missing. Install the binary, then reload the extension to get the binary's exact tool list.

## Install

1. Copy `donsetch.ts` to `~/.pi-pocket/extensions/`.
2. Open Menu → Extensions and turn on **donsetch** under **Yours**.
3. Start a session and ask: `Fetch https://example.com`.

The addon starts one MCP session for each Pi Pocket conversation. This keeps `S1`/`L12` handles and `since_last` inside the conversation that made them. The addon keeps up to 4 sessions. A fifth conversation closes the least recently used idle session. If all are busy, it opens another. Idle sessions close after 30 minutes.

## Updates

The tool list and behavior come from the binary, not from this file.

- Update the binary with the Pi package, `donsetch update`, or npm.
- Reload the module to pick up new tools: save `donsetch.ts`, or turn it off and on. The addon shows a notice when it sees that the binary changed on disk.
- Run `npm run probe` to print the current tool list and schemas.
- Run `npm run check-upstream` to compare the npm package's `pi-extension.ts` bridge assumptions with `upstream.lock.json`. It does not change the addon.
- The GitHub Actions template `.github/workflows/upstream.yml` runs the check daily and probes the latest npm package. It opens an issue on failure. It never merges or installs code by itself.

Pi Pocket's gallery also never updates a module by itself. It shows the diff and the owner applies it.

## Configuration

| Variable | Effect |
|---|---|
| `DONSETCH_BINARY` | Path to the donsetch executable. An invalid path is an error; the addon does not fall back. |
| `DONSETCH_DEBUG=1` or `DEBUG=1` | Forward donsetch stderr to the Pi Pocket server log. |

## Limits

- One call waits for the tool's own budget plus 20 seconds of slack, capped at 620 seconds.
- `web_fetch` and the other tools with `deadline_ms`, and `web_crawl` with `deadline_s`, use the budget in the call.
- Cancelling the tool call sends the cancellation to the MCP server.
- A dropped MCP connection is retried once. The normal calls are reads. `web_fetch` can run page actions (`click`, `type`, `press`); avoid actions with important side effects.

## Security

- The addon runs the local `donsetch` binary with the Pi Pocket server's rights.
- Web page text and images go to the model as tool results. They are data, not instructions. The addon never puts page text in the system prompt.
- `web_fetch` page actions can change state on the remote page. Use them only when the request needs them.
- The addon does not read provider keys, cookies, or other credentials. DonSeTch manages its own local state.
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
npm run probe                                # real binary, lists tools
npm run check-upstream
```

The test defaults to `~/pi-pocket` when `PI_POCKET_REPO` is not set. It imports Pi Pocket's helpers and uses a temporary data folder.

## License

MIT. See `LICENSE`.

DonSeTch is AGPL-3.0 and is a separate program. This addon does not include DonSeTch code; it talks to the binary over MCP. `@earendil-works/pi-mcp` is MIT.
