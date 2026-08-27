import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relativePath) => readFileSync(resolve(root, relativePath), "utf8");
const fail = (message) => {
  throw new Error(`Runtime artifact coverage check failed: ${message}`);
};
const requireText = (text, value, context) => {
  if (!text.includes(value)) fail(`${context} must include ${JSON.stringify(value)}`);
};

// These are the Dockerized runtime roles. The control-panel is intentionally absent:
// it is a static SPA bundled by the review-dashboard image, verified below.
const runtimeArtifacts = [
  ["review-dashboard", "Dockerfile.review-dashboard"],
  ["marketing-site", "Dockerfile.marketing-site"],
  ["orchestrator", "Dockerfile.orchestrator"],
  ["video-worker", "Dockerfile.video-worker"]
];

const ci = read(".github/workflows/ci.yml");
const compose = read("docker-compose.yml");
const dashboardDockerfile = read("Dockerfile.review-dashboard");
const workerDockerfile = read("Dockerfile.video-worker");
const deployGuide = read("docs/deploy-fly.md");
const dashboardServer = read("apps/review-dashboard/src/server.ts");
const controlPanelIndex = resolve(root, "apps/control-panel/dist/index.html");

for (const [image, dockerfile] of runtimeArtifacts) {
  if (!existsSync(resolve(root, dockerfile))) fail(`${dockerfile} is missing for ${image}`);
  const escapedDockerfile = dockerfile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`- image: ${image}\\r?\\n\\s+dockerfile: ${escapedDockerfile}`).test(ci)) {
    fail(`CI release matrix must include ${image} using ${dockerfile}`);
  }
}

for (const [service, dockerfile] of runtimeArtifacts) {
  requireText(compose, `${service}:`, "Compose runtime topology");
  requireText(compose, `dockerfile: ${dockerfile}`, "Compose runtime topology");
}

requireText(ci, "push: true", "CI image publishing");
requireText(ci, "sbom: true", "CI artifact SBOM");
requireText(ci, "provenance: mode=max", "CI artifact provenance");
requireText(workerDockerfile, 'ENTRYPOINT ["node", "dist/index.js"]', "video-worker runtime image");
requireText(workerDockerfile, "HEALTHCHECK", "video-worker runtime image");

// Bundle contract: the dashboard image builds every workspace app (including the
// control-panel) and the deploy guide records the same ownership explicitly.
requireText(dashboardDockerfile, "COPY apps/control-panel/package.json apps/control-panel/package.json", "control-panel bundle");
requireText(dashboardDockerfile, "COPY apps apps", "control-panel bundle");
requireText(dashboardDockerfile, "RUN pnpm -r run build", "control-panel bundle");
if (!existsSync(controlPanelIndex)) fail("control-panel production bundle is missing; run the workspace build before this check");
requireText(readFileSync(controlPanelIndex, "utf8"), '<div id="root">', "control-panel production bundle");
requireText(dashboardServer, "CONTROL_PANEL_DIST", "control-panel serving contract");
requireText(dashboardServer, 'app.use("/app", serveControlPanel)', "control-panel serving contract");
requireText(deployGuide, "there is no separate control-panel image to build or host", "control-panel deployment ownership");
if (ci.includes("- image: control-panel")) fail("control-panel must be bundled by review-dashboard, not published as a separate image");

console.log(`Runtime artifact coverage verified: ${runtimeArtifacts.map(([image]) => image).join(", ")}; control-panel is bundled by review-dashboard.`);
