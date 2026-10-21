import { test } from "node:test";
import assert from "node:assert/strict";
import { createController, CONFIG_KEY } from "../lib/controller";
import { updateEnvironment } from "../lib/environments";
import { compileRules, validateConfig } from "../lib/rules";
import {
  activeRules,
  emptyConfig,
  type Config,
  type Rule,
  type EnvironmentCommand,
} from "../lib/types";

const rule = (extra: Partial<Rule> = {}): Rule => ({
  id: "legacy-rule",
  kind: "header",
  key: "X-Environment",
  value: "default",
  enabled: true,
  scope: "global",
  pattern: "",
  includeSubdomains: false,
  operation: "set",
  ...extra,
});
function fixture(config: unknown) {
  const store: Record<string, any> = { [CONFIG_KEY]: structuredClone(config) };
  let installed: chrome.declarativeNetRequest.Rule[] = [];
  let failure: "dnr" | "storage" | null = null;
  const api = {
    storage: {
      local: {
        get: async () => structuredClone(store),
        set: async (value: Record<string, unknown>) => {
          if (failure === "storage" && CONFIG_KEY in value) {
            failure = null;
            throw new Error("storage failed");
          }
          Object.assign(store, structuredClone(value));
        },
      },
    },
    declarativeNetRequest: {
      isRegexSupported: async () => ({ isSupported: true }),
      getDynamicRules: async () => structuredClone(installed),
      updateDynamicRules: async (value: {
        addRules: chrome.declarativeNetRequest.Rule[];
      }) => {
        if (failure === "dnr") {
          failure = null;
          throw new Error("dnr failed");
        }
        installed = structuredClone(value.addRules);
      },
    },
  } as unknown as typeof chrome;
  const controller = createController(api);
  return {
    controller,
    store,
    installed: () => installed,
    fail: (next: typeof failure) => {
      failure = next;
    },
    change: (command: EnvironmentCommand) =>
      controller.mutate((c) => updateEnvironment(c, command)),
  };
}
test("existing v2 data migrates once into default environment without losing rule IDs or values", async () => {
  const previous = { version: 2, enabled: true, rules: [rule()] };
  const f = fixture(previous);
  await f.controller.sync();
  const migrated = await f.controller.read();
  assert.equal(migrated.activeEnvironmentId, "default");
  assert.deepEqual(migrated.environments, [
    { id: "default", name: "默认环境" },
  ]);
  assert.equal(migrated.rules[0]!.id, previous.rules[0]!.id);
  assert.equal(migrated.rules[0]!.value, "default");
  assert.equal(migrated.rules[0]!.environmentId, "default");
  assert.deepEqual(f.store.headerManagerBeforeEnvironments, previous);
  assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "default");
  await f.controller.read();
  assert.deepEqual(f.store.headerManagerBeforeEnvironments, previous);
});
test("switching environments isolates same-name Header and Cookie rules and survives controller restart", async () => {
  const f = fixture({ ...emptyConfig(), rules: [rule()] });
  await f.controller.sync();
  let config = await f.change({ action: "create", name: "测试环境" });
  const staging = config.activeEnvironmentId;
  assert.equal(f.installed().length, 0);
  await f.controller.saveRule(
    rule({ id: "", value: "staging", environmentId: staging }),
  );
  config = await f.controller.saveRule(
    rule({
      id: "",
      key: "Cookie",
      kind: "cookie",
      value: "tenant=test",
      environmentId: staging,
    }),
  );
  assert.equal(f.installed().length, 2);
  assert.equal(activeRules(config).length, 2);
  await f.change({ action: "switch", id: "default" });
  assert.equal(f.installed().length, 1);
  assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "default");
  await f.change({ action: "switch", id: staging });
  assert.equal((await f.controller.read()).rules.length, 3);
  const restarted = fixture(f.store[CONFIG_KEY]);
  await restarted.controller.sync();
  assert.equal(
    (await restarted.controller.read()).activeEnvironmentId,
    staging,
  );
  assert.equal(restarted.installed().length, 2);
});
test("duplicate creates independent rule IDs; rename/delete preserve source and last environment", async () => {
  const f = fixture({ ...emptyConfig(), rules: [rule()] });
  const source = await f.controller.read();
  let copy = await f.change({
    action: "duplicate",
    id: "default",
    name: "预发环境",
  });
  const copiedId = copy.activeEnvironmentId;
  assert.notEqual(activeRules(copy)[0]!.id, source.rules[0]!.id);
  await f.controller.saveRule({
    ...activeRules(copy)[0]!,
    value: "pre-release",
  });
  copy = await f.change({ action: "rename", id: copiedId, name: "预发布" });
  assert.equal(
    copy.environments.find((e) => e.id === copiedId)!.name,
    "预发布",
  );
  assert.equal(
    copy.rules.find((r) => r.environmentId === "default")!.value,
    "default",
  );
  const deleted = await f.change({ action: "delete", id: copiedId });
  assert.equal(deleted.activeEnvironmentId, "default");
  assert.equal(deleted.rules.length, 1);
  await assert.rejects(
    f.change({ action: "delete", id: "default" }),
    /至少保留/,
  );
});
test("failed environment commits restore both previous active group and installed rules", async () => {
  const f = fixture({ ...emptyConfig(), rules: [rule()] });
  await f.controller.sync();
  for (const failure of ["dnr", "storage"] as const) {
    const before = await f.controller.read();
    f.fail(failure);
    await assert.rejects(
      f.change({ action: "create", name: "failed" }),
      /failed/,
    );
    assert.deepEqual(await f.controller.read(), before);
    assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "default");
  }
});
test("environment validation rejects duplicate names, orphaned rules and stale editor saves", async () => {
  const f = fixture({ ...emptyConfig(), rules: [rule()] });
  await assert.rejects(
    f.change({ action: "create", name: "  默认环境  " }),
    /重复/,
  );
  await assert.rejects(f.change({ action: "create", name: " " }), /名称/);
  const second = await f.change({ action: "create", name: "test" });
  await assert.rejects(
    f.controller.saveRule(rule({ environmentId: "default" })),
    /环境已切换/,
  );
  await assert.rejects(f.controller.saveRule(rule()), /不属于/);
  assert.throws(
    () =>
      validateConfig({
        ...second,
        rules: [rule({ environmentId: "missing" })],
      }),
    /不存在/,
  );
  assert.equal(
    (await f.controller.read()).activeEnvironmentId,
    second.activeEnvironmentId,
  );
});
test("global pause remains paused across group changes and limits apply across all environments", async () => {
  const f = fixture({ ...emptyConfig(), enabled: false, rules: [rule()] });
  let config = await f.change({
    action: "duplicate",
    id: "default",
    name: "test",
  });
  assert.equal(config.enabled, false);
  assert.equal(compileRules(config).length, 0);
  assert.throws(
    () =>
      validateConfig({
        ...config,
        environments: Array.from({ length: 31 }, (_, i) => ({
          id: String(i),
          name: String(i),
        })),
      }),
    /数量/,
  );
  config = await f.change({ action: "switch", id: "default" });
  assert.equal(f.installed().length, 0);
  assert.equal(config.rules.length, 2);
});
