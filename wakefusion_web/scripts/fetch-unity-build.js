#!/usr/bin/env node
/**
 * Postinstall hook: download the Unity WebGL build (Build.zip) from GitHub Releases.
 *
 * Why: Build.data is ~245 MB, exceeds GitHub's 100 MB single-file limit.
 * We host it as a Release asset instead of in git history.
 *
 * If the download fails (firewall / no internet), the user can manually unzip
 * Build.zip from the Releases page into wakefusion_web/public/Build/.
 *
 * Override the source URL via env var: UNITY_BUILD_URL=https://...
 * Skip the download via: SKIP_UNITY_BUILD=1 npm install
 */

import { existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const buildDir = resolve(repoRoot, "public", "Build");
const expectedFiles = ["Build.data", "Build.framework.js", "Build.loader.js", "Build.wasm"];

const UNITY_BUILD_URL = process.env.UNITY_BUILD_URL
  || "https://github.com/canfor-cn/industrial-assistant-frontdevice/releases/latest/download/Build.zip";

if (process.env.SKIP_UNITY_BUILD === "1") {
  console.log("[fetch-unity-build] SKIP_UNITY_BUILD=1 set, skipping download.");
  process.exit(0);
}

// Already have all 4 files? skip.
const allPresent = expectedFiles.every((f) => existsSync(resolve(buildDir, f)));
if (allPresent) {
  console.log("[fetch-unity-build] Build/ already populated, skipping download.");
  process.exit(0);
}

console.log(`[fetch-unity-build] Downloading Unity build...`);
console.log(`  source: ${UNITY_BUILD_URL}`);
console.log(`  target: ${buildDir}/`);

mkdirSync(buildDir, { recursive: true });
const zipPath = resolve(buildDir, "Build.zip");

// Use Node's built-in fetch (Node 18+) to download
async function download() {
  try {
    const res = await fetch(UNITY_BUILD_URL, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const total = Number(res.headers.get("content-length") || 0);
    console.log(`  size: ${(total / 1024 / 1024).toFixed(1)} MB`);

    const out = createWriteStream(zipPath);
    let received = 0;
    let lastReported = 0;
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(value);
      received += value.length;
      const pct = total > 0 ? (received / total) * 100 : 0;
      if (pct - lastReported >= 10) {
        console.log(`  ${pct.toFixed(0)}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
        lastReported = pct;
      }
    }
    out.end();
    await new Promise((r) => out.on("finish", r));
    return true;
  } catch (e) {
    console.warn(`[fetch-unity-build] Download failed: ${e.message}`);
    return false;
  }
}

async function unzip() {
  // Use system unzip / Expand-Archive
  const isWindows = process.platform === "win32";
  if (isWindows) {
    const cmd = "powershell.exe";
    const args = ["-NoProfile", "-Command", `Expand-Archive -Path "${zipPath}" -DestinationPath "${buildDir}" -Force`];
    const r = spawnSync(cmd, args, { stdio: "inherit" });
    return r.status === 0;
  }
  const r = spawnSync("unzip", ["-o", zipPath, "-d", buildDir], { stdio: "inherit" });
  return r.status === 0;
}

(async () => {
  const ok = await download();
  if (!ok) {
    console.warn(`[fetch-unity-build] ⚠️  Auto-download failed.`);
    console.warn(`  → Please manually download Build.zip from:`);
    console.warn(`    ${UNITY_BUILD_URL}`);
    console.warn(`  → Unzip into: ${buildDir}/`);
    console.warn(`  → Then re-run: npm run build`);
    // Don't fail npm install — the user can just unzip manually
    process.exit(0);
  }
  console.log(`[fetch-unity-build] Extracting...`);
  const unzipOk = await unzip();
  if (!unzipOk) {
    console.warn(`[fetch-unity-build] ⚠️  Unzip failed. Please extract ${zipPath} manually.`);
    process.exit(0);
  }
  // Clean up temp zip
  try { (await import("node:fs/promises")).unlink(zipPath); } catch { /* ignore */ }
  console.log(`[fetch-unity-build] ✓ Done. public/Build/ is ready.`);
})();
