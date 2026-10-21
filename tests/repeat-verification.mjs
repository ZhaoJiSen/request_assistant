import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logs = [];
let failed = false;
for (let run = 1; run <= 3; run++) {
  for (const [name, args] of [
    ["core", ["--import", "tsx", "--test", "tests/core.test.ts"]],
    ["browser", ["tests/browser-e2e.mjs"]],
  ]) {
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
    });
    const text = `Run ${run} ${name}\n${result.stdout || ""}${result.stderr || ""}\n`;
    logs.push(text);
    process.stdout.write(text);
    if (result.status !== 0) {
      failed = true;
      break;
    }
  }
  if (failed) break;
}
mkdirSync(resolve(root, "evidence"), { recursive: true });
writeFileSync(resolve(root, "evidence/verification-runs.log"), logs.join("\n"));
if (failed) process.exitCode = 1;
