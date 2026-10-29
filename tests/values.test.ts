import { test } from "node:test";
import assert from "node:assert/strict";
import { createController, CONFIG_KEY } from "../lib/controller";
import { updateEnvironment } from "../lib/environments";
import {
  compileRules,
  validateConfig,
  validateRule,
  selectRuleValue,
} from "../lib/rules";
import { emptyConfig, type Rule, type EnvironmentCommand } from "../lib/types";
import { exportRules, parseRules } from "../lib/transfer";
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

test("Header choices validate all values and preserve legacy single values", () => {
  assert.equal(validateRule(rule()).values, undefined);
  const value = rule({ value: "", values: ["", "898", "899"] });
  assert.deepEqual(validateRule(value).values, ["", "898", "899"]);
  for (const values of [
    ["898", "898"],
    ["bad\n", "898"],
    ["x".repeat(16001), "898"],
    Array.from({ length: 31 }, (_, i) => String(i)),
    [],
  ]) {
    assert.throws(() => validateRule(rule({ value: "898", values })));
  }
  assert.throws(
    () => validateRule(rule({ value: "missing", values: ["898", "899"] })),
    /当前值/,
  );
  assert.throws(
    () =>
      validateRule(
        rule({ kind: "cookie", key: "Cookie", value: "a=1", values: ["a=1"] }),
      ),
    /Header 候选值/,
  );
});
test("selection commits current value, preserves metadata and reloads after restart", async () => {
  const f = fixture({
    ...emptyConfig(),
    rules: [rule({ value: "898", values: ["898", "899", ""] })],
  });
  await f.controller.sync();
  const config = await f.controller.mutate((c) =>
    selectRuleValue(c, {
      id: "legacy-rule",
      environmentId: "default",
      value: "899",
    }),
  );
  assert.equal(config.rules[0]!.value, "899");
  assert.deepEqual(config.rules[0]!.values, ["898", "899", ""]);
  assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "899");
  const restarted = fixture(f.store[CONFIG_KEY]);
  await restarted.controller.sync();
  assert.equal((await restarted.controller.read()).rules[0]!.value, "899");
  await f.controller.mutate((c) =>
    selectRuleValue(c, {
      id: "legacy-rule",
      environmentId: "default",
      value: "",
    }),
  );
  assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "");
});
test("selection rejects stale environment or candidates, and failed commits restore selection", async () => {
  const f = fixture({
    ...emptyConfig(),
    rules: [rule({ value: "898", values: ["898", "899"] })],
  });
  await f.controller.sync();
  for (const input of [
    { id: "legacy-rule", environmentId: "other", value: "899" },
    { id: "legacy-rule", environmentId: "default", value: "removed" },
    { id: "gone", environmentId: "default", value: "899" },
  ]) {
    await assert.rejects(f.controller.mutate((c) => selectRuleValue(c, input)));
  }
  for (const failure of ["dnr", "storage"] as const) {
    f.fail(failure);
    await assert.rejects(
      f.controller.mutate((c) =>
        selectRuleValue(c, {
          id: "legacy-rule",
          environmentId: "default",
          value: "899",
        }),
      ),
      /failed/,
    );
    assert.equal((await f.controller.read()).rules[0]!.value, "898");
    assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "898");
  }
});
test("choices round-trip through export/import and paused or disabled rules stay inactive", async () => {
  const config = {
    ...emptyConfig(),
    rules: [rule({ value: "899", values: ["898", "899"], enabled: false })],
  };
  const parsed = parseRules(exportRules(config, "header"), {
    target: "header",
    conflict: "skip",
    scope: "global",
    pattern: "",
    operation: "set",
  });
  assert.deepEqual(parsed[0]!.values, ["898", "899"]);
  assert.equal(parsed[0]!.value, "899");
  const f = fixture(config);
  await f.controller.mutate((c) =>
    selectRuleValue(c, {
      id: "legacy-rule",
      environmentId: "default",
      value: "898",
    }),
  );
  assert.equal(f.installed().length, 0);
  const paused = selectRuleValue(
    {
      ...config,
      enabled: false,
      rules: [{ ...config.rules[0]!, enabled: true }],
    },
    { id: "legacy-rule", environmentId: "default", value: "898" },
  );
  assert.equal(compileRules(paused).length, 0);
  assert.equal(validateConfig(paused).rules[0]!.value, "898");
});
