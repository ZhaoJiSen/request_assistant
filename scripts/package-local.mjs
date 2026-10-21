import { cp, mkdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// This directory contains generated files only; source and saved browser data are separate.
const destination = resolve(root, "chrome-extension");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(resolve(root, ".output/chrome-mv3-dev"), destination, {
  recursive: true,
});
console.log(`可在 Chrome 中加载：${destination}`);
