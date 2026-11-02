import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The CI script intentionally has no dependency on the build runtime.
import {
  setPackageVersion,
  validateVersion,
} from "../scripts/set-package-version.mjs";

test("CI accepts numeric Chrome versions and rejects invalid or unsafe version input", () => {
  for (const version of ["2.2.0", "0.0.1", "65535.65535.65535"])
    assert.equal(validateVersion(version), version);
  for (const version of [
    undefined,
    "",
    "0.0.0",
    "v2.2.0",
    "2.2",
    "2.2.0.1",
    "02.2.0",
    "2.2.65536",
    "2.2.0-beta",
    "2.2.0\n",
    "2.2.0; touch injected",
    "$(whoami)",
    "../../oops",
  ])
    assert.throws(() => validateVersion(version));
});

test("CI writes matching package and lock versions while preserving dependencies; invalid input writes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "request-helper-version-"));
  const pkg = {
    name: "request-helper",
    version: "2.1.0",
    dependencies: { vue: "^3.5.0" },
  };
  const lock = {
    version: "2.1.0",
    packages: {
      "": structuredClone(pkg),
      "node_modules/vue": { version: "3.5.0" },
    },
  };
  try {
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
    await assert.rejects(setPackageVersion(root, "bad"));
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "package.json"), "utf8")),
      pkg,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")),
      lock,
    );
    await setPackageVersion(root, "2.2.0");
    const next = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const nextLock = JSON.parse(
      await readFile(join(root, "package-lock.json"), "utf8"),
    );
    assert.equal(next.version, "2.2.0");
    assert.equal(nextLock.version, "2.2.0");
    assert.equal(nextLock.packages[""].version, "2.2.0");
    assert.deepEqual(next.dependencies, pkg.dependencies);
    assert.deepEqual(
      nextLock.packages["node_modules/vue"],
      lock.packages["node_modules/vue"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
