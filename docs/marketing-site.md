# Marketing site — video content workflow

`apps/marketing-site` is a manifest-driven landing page: every video-shaped element on the page (hero clip, the "See it in action" gallery, the UGC review wall) is rendered server-side from a single file, [`apps/marketing-site/content/video-manifest.json`](../apps/marketing-site/content/video-manifest.json). Nothing else in the page needs to change when real video is ready — only the manifest.

## Entry shape

```json
{
  "id": "demo-fitness",
  "type": "product-demo",
  "niche": "fitness",
  "platform": "tiktok",
  "aspectRatio": "9:16",
  "hook": "...", "points": ["..."], "cta": "...",
  "creatorHandle": "@handle",
  "viralityScore": 87,
  "videoPath": "/videos/demo-fitness.mp4",
  "posterPath": "/videos/demo-fitness.svg",
  "status": "placeholder" | "ready"
}
```

- `status: "placeholder"` → the card renders `posterPath` as a static image with no `<video>` element (never a broken/empty video tag).
- `status: "ready"` → the card renders a real `<video>` (muted/looping for the hero, click-to-unmute-and-play for gallery/wall cards via `public/script.js`), using `videoPath` and `posterPath` as the poster frame.
- `creatorHandle` is only used by UGC-review entries (rendered as a handle overlay under the caption).
- `viralityScore` is only shown when non-null — pulls the same scoring concept used by the real pipeline's QA stage (`ReviewItem.score` in `packages/shared-schema`), which is Claude-scored (`apps/orchestrator/src/agents/qa-agent.ts`), not a vendor tool. Higgsfield's own `virality_predictor` is intentionally not used anywhere in this pipeline — see `docs/architecture.md`'s vendor-boundary note.

The current manifest ships with all 8 entries at `status: "placeholder"` and hand-authored SVG poster frames in `public/videos/` (dark gradient, niche/handle label, "Generating soon" badge) so the page is fully functional and honest today.

## Generating real clips (Phase B — needs Higgsfield authorized)

Higgsfield's MCP tools aren't reachable from this repo's plain Node code directly — they're only available inside a Claude session with the Higgsfield connector authorized. The server is now registered for this project at [`.mcp.json`](../.mcp.json) (`https://mcp.higgsfield.ai/mcp`), but registering it isn't the same as authorizing it: open an **interactive** Claude Code session in this repo and run `/mcp` to complete the OAuth flow (this can't happen in a non-interactive session). Once authorized:

**Product-demo entries** — reuse the existing pipeline, don't write one-off generation code:
1. Run the real conductor per entry using its `niche`/`hook`/`points`/`cta` as the script input (same code path as `vvugc run`, see `packages/mcp-video-gen` + `packages/mcp-assembly`).
2. Copy the resulting assembled `.mp4` into `apps/marketing-site/public/videos/<id>.mp4`, and a frame grab into `<id>.jpg` (or keep the existing `.svg` as poster if it still reads well).
3. Update that entry in `video-manifest.json`: `status: "ready"`, `videoPath`, `posterPath`, `viralityScore` (pull the real score from the QA stage's output — a Claude-scored value, not a Higgsfield one).

**UGC-review entries** — need a persona/voice, not just b-roll, so use Higgsfield's avatar tools directly rather than the standard pipeline:
1. `create_voice` (or pick an existing voice) for the creator persona.
2. `shorts_studio_create` / `shorts_studio_create_preset` or `generate_video` with an avatar reference, scripted from the entry's `hook`/`points`/`cta`, framed as a native vertical talking-head testimonial.
3. Same drop-in + manifest update as above.

No page code changes are needed for either path — `src/server.ts`'s `renderVideoCard`/`renderHeroBlock` already branch on `status`.

## Verifying the ready-state path without real clips

```bash
# Flip one entry to "ready" with a stub videoPath, confirm the <video> markup renders,
# then revert — useful for testing the rendering path before Phase B produces real output.
```

See `docs/architecture.md` for how this page fits into the rest of the system.
