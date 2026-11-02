import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateVersion(version) {
  if (
    typeof version !== "string" ||
    version !== version.trim() ||
    !/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(version) ||
    version.split(".").some((part) => Number(part) > 65535) ||
    version.split(".").every((part) => Number(part) === 0)
  ) {
    throw new Error(
      "版本号应为 X.Y.Z，每段 0–65535，不能全部为 0；不要加 v 或预发布后缀",
    );
  }
  return version;
}

export async function setPackageVersion(root, input) {
  const version = validateVersion(input);
  const packagePath = resolve(root, "package.json");
  const lockPath = resolve(root, "package-lock.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (!lock.packages?.[""]) throw new Error("package-lock.json 缺少根包信息");
  pkg.version = lock.version = lock.packages[""].version = version;
  await writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n");
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await setPackageVersion(process.cwd(), process.env.VERSION);
  console.log(`本次构建版本：${process.env.VERSION}`);
}
