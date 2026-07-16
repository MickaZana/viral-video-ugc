import { assembleVideo } from "./dist/lib.js";

const base = "C:/Users/mican/AppData/Local/Temp/vvugc-live-test";
const clips = [
  { id: "clip-0", scriptSegmentIndex: 0, filePath: `${base}/clips/clip0.mp4`, durationSec: 2, vendor: "higgsfield" },
  { id: "clip-1", scriptSegmentIndex: 1, filePath: `${base}/clips/clip1.mp4`, durationSec: 2, vendor: "higgsfield" }
];
const script = {
  videoId: "live-test-1",
  hook: "Real ffmpeg test",
  points: ["point one"],
  cta: "cta",
  durationSec: 4,
  brandVoice: "energetic",
  trendingPhrases: ["realtest"]
};
const captions = [
  { startSec: 0, endSec: 2, text: "Real ffmpeg test" },
  { startSec: 2, endSec: 4, text: "point one" }
];

const result = await assembleVideo({
  clips,
  script,
  captions,
  platform: "tiktok",
  outDir: `${base}/assembled`,
  dryRun: false
});
console.log(JSON.stringify(result, null, 2));
