import { spawn } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
const root = new URL("..", import.meta.url);
const output = new URL("../evidence/header-values/", import.meta.url);
await mkdir(output, { recursive: true });
const log = new URL("verification-runs.log", output);
await writeFile(
  log,
  `Header choices verification ${new Date().toISOString()}\n`,
);
const commands = [
  [
    "--import",
    "tsx",
    "--test",
    "tests/values.test.ts",
    "tests/transfer.test.ts",
    "tests/environments.test.ts",
  ],
  ["tests/values-browser.mjs"],
  ["tests/environment-browser.mjs"],
  ["tests/transfer-browser.mjs"],
  ["tests/browser-e2e.mjs"],
];
async function run(args) {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    for (const stream of [p.stdout, p.stderr])
      stream.on("data", (d) => {
        out += d;
        process.stdout.write(d);
      });
    p.on("error", reject);
    p.on("exit", async (code) => {
      await appendFile(log, out);
      code === 0
        ? resolve()
        : reject(new Error(`${args.join(" ")} exited ${code}`));
    });
  });
}
for (let round = 1; round <= 3; round++) {
  for (const args of commands) {
    console.log(`ROUND ${round}: ${args.join(" ")}`);
    await appendFile(log, `ROUND ${round}: ${args.join(" ")}\n`);
    await run(args);
  }
  await appendFile(log, `ROUND ${round} PASSED\n`);
}
await run(["tests/popup-size.mjs"]);
await writeFile(
  new URL("regression-result.json", output),
  JSON.stringify(
    {
      result: "passed",
      rounds: 3,
      commands,
      finishedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
