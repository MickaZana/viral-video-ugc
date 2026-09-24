# MCP connectors — driving the pipeline from an agent

This repo exposes its full pipeline (discover → transcribe → script rewrite →
video-gen → assembly → QA → human review queue) as a local MCP server —
`apps/orchestrator/src/mcp-server.ts`, package name `@vvugc/orchestrator` —
so an MCP-speaking agent (Claude Code, Codex CLI) can drive a run end to end
instead of the operator running the CLI by hand.

## What this is (and isn't)

- **Local only.** The agent spawns this server as a subprocess on your own
  machine, over stdio. It reads the same `.env` this repo already uses — your
  own vendor keys, your own spend, no network exposure.
- **Not the same shape as Higgsfield's MCP** (registered in `.mcp.json`
  alongside this one). Higgsfield's is a remote, hosted, multi-user server
  with per-user OAuth and per-user billing. This one is single-user and
  local by design — see "Why not hosted yet" below.
- **The pipeline logic isn't duplicated.** The server is a thin protocol
  wrapper: its tools call straight into `runCycle` (`conductor.ts`) and
  `@vvugc/review-queue`, the same functions the CLI (`vvugc run`) already
  uses. Job tracking lives in `apps/orchestrator/src/mcp/jobs.ts`, kept free
  of any MCP-specific code on purpose — a future hosted/multi-user server
  would reuse that file as-is.

## Tools it exposes

| Tool | What it does | Spends money? |
|---|---|---|
| `discover` | Find viral videos in a niche/platform with their metrics | No |
| `start_run` | Kick off one full pipeline cycle; returns a `runId` immediately (a live run can take many minutes) | Only if `dryRun: false` **and** `confirmLiveSpend: true` |
| `get_run_status` | Poll a run's phase + recent progress lines | No |
| `get_run_result` | Get a finished run's manifest (candidates, review items, spend) | No |
| `list_review_queue` | List items awaiting human review | No |
| `get_review_item` | Get one review item by id | No |
| `approve_review_item` / `reject_review_item` | Change a review item's status. Deliberately separate from `start_run` — a run can never post anything by itself | No |

`start_run` refuses to spend money unless you explicitly say so twice
(`dryRun: false` *and* `confirmLiveSpend: true`). Live runs are still capped
by the pipeline's own limits ($25/run, 8 clips/flow) — see `conductor.ts`.

## Connect Claude Code

Already wired: `.mcp.json` at the repo root has a `vvugc-conductor` entry.
Open Claude Code in this repo and it's available. To point a **different**
Claude Code session (e.g. a clone elsewhere) at it, either copy that block:

```json
{
  "mcpServers": {
    "vvugc-conductor": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["--filter", "@vvugc/orchestrator", "mcp-server"]
    }
  }
}
```

into that repo's own `.mcp.json`, or add it imperatively from the repo root:

```sh
claude mcp add vvugc-conductor -- pnpm --filter @vvugc/orchestrator mcp-server
```

## Connect Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.vvugc-conductor]
command = "pnpm"
args = ["--filter", "@vvugc/orchestrator", "mcp-server"]
cwd = "/absolute/path/to/Viral Video UGC"
```

(`cwd` matters for Codex — unlike Claude Code, it doesn't necessarily spawn
relative to the project it's running in, so give it an absolute path to this
repo.) Codex's exact config surface has moved before; if this doesn't match
what you see, check `codex mcp --help` or the current Codex docs for the
`mcp_servers` section.

## Connect ChatGPT — not yet, and it's a bigger job than a snippet

ChatGPT can't spawn a local process the way Claude Code/Codex do — its
connectors need a server reachable over **HTTP** at a URL. Wiring that up
for real (not just "works on my machine") means:

1. Standing up `mcp-server.ts` behind an HTTP/SSE transport instead of stdio
   (the SDK supports this; this repo doesn't have that entrypoint yet).
2. Hosting it somewhere persistent and reachable.
3. Adding real auth (API key or OAuth) — a `start_run` tool sitting on an
   open URL is a tap anyone with the link can spend real vendor money
   through.

That's the same shape as Higgsfield's own MCP (hosted, per-user auth,
per-user billing) — a real build, not a config snippet. Worth doing later;
not done here. `startRunJob`/`getRunJob` in `mcp/jobs.ts` were written
transport-agnostic specifically so that work reuses them instead of
duplicating pipeline logic.

## Verifying it works

```sh
node -e "
import('@modelcontextprotocol/sdk/client/index.js').then(async ({ Client }) => {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'smoke', version: '0.0.1' });
  await client.connect(new StdioClientTransport({
    command: 'pnpm', args: ['--filter', '@vvugc/orchestrator', 'mcp-server']
  }));
  console.log(await client.listTools());
  await client.close();
});
"
```

should print the 8 tools above. A `start_run` call with `dryRun: true` costs
nothing and exercises the whole pipeline with mocked stages — the safe way
to confirm the wiring before ever setting `confirmLiveSpend: true`.
