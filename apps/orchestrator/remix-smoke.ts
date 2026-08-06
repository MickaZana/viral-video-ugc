/**
 * One-off smoke test for the remix-from-URL transcript path (Elephant 1).
 * Verifies, against the real internet, that:
 *   1. parseSourceUrl recognizes real public share URLs.
 *   2. fetchYouTubeCaptions can resolve a transcript for real public videos
 *      via the free timedtext endpoint (no API key, no ASR/yt-dlp dependency).
 * Run: node_modules\.pnpm\tsx@4.23.1\node_modules\tsx\dist\cli.mjs remix-smoke.ts
 */
import { fetchYouTubeCaptions } from '@vvugc/mcp-transcript'
import { parseSourceUrl } from './src/remix-source.js'

const SAMPLES = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // Rick Astley
  'https://www.youtube.com/watch?v=jNQXAC9IVRw', // "Me at the zoo"
  'https://www.youtube.com/watch?v=9bZkp7q19f0', // Gangnam Style
  'https://youtu.be/aqz-KE-bpKQ' // Big Buck Bunny (commonly has captions)
]

async function main() {
  console.log('=== 1) parseSourceUrl on real URLs ===')
  for (const u of SAMPLES) {
    const p = parseSourceUrl(u)
    console.log(`${p ? 'OK ' : 'FAIL'} ${u} -> ${p ? JSON.stringify(p) : 'unrecognized'}`)
  }

  console.log('\n=== 2) fetchYouTubeCaptions on real public videos ===')
  for (let i = 0; i < SAMPLES.length; i++) {
    const u = SAMPLES[i]
    const p = parseSourceUrl(u)
    if (!p) continue
    if (i > 0) await new Promise((r) => setTimeout(r, 2500)) // space requests to dodge YouTube rate-limiting
    const t0 = Date.now()
    try {
      const t = await fetchYouTubeCaptions(p.videoId)
      const ms = Date.now() - t0
      if (t) {
        console.log(`OK   ${p.videoId} (${ms}ms) -> ${t.text.length} chars, ${t.segments.length} cues: "${t.text.slice(0, 80)}..."`)
      } else {
        console.log(`EMPTY ${p.videoId} (${ms}ms) -> no captions resolved (public endpoint returned nothing)`)
      }
    } catch (err) {
      const ms = Date.now() - t0
      console.log(`ERR  ${p.videoId} (${ms}ms) -> ${String(err).slice(0, 160)}`)
    }
  }
  console.log('\nSmoke test done.')
}

main().catch((e) => {
  console.error('Smoke test crashed:', e)
  process.exit(1)
})
