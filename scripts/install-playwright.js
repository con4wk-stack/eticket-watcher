import { execSync } from "child_process";
import path from "path";
if (process.env.SKIP_PLAYWRIGHT_INSTALL === "1") {
  console.log("[playwright] SKIP_PLAYWRIGHT_INSTALL=1, skipping");
  process.exit(0);
}

const root = process.cwd();
const browsersPath = path.join(root, "playwright-browsers");

process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;

try {
  console.log("[playwright] Installing chromium-headless-shell to", browsersPath);
  execSync("npx playwright install chromium-headless-shell", {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
    cwd: root,
  });
  console.log("[playwright] Install OK");
} catch (e) {
  console.error("[playwright] Install failed:", e.message);
  process.exit(1);
}
