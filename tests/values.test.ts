import { test } from "node:test";
import assert from "node:assert/strict";
import { createController, CONFIG_KEY } from "../lib/controller";
import { updateEnvironment } from "../lib/environments";
import {
  compileRules,
  validateConfig,
  validateRule,
  selectRuleValue,
  editRuleValue,
  removeRuleValue,
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

test("aliases validate, follow candidates through selection, copy and import/export", () => {
  const current = rule({
    value: "898",
    values: ["898", "231"],
    valueAliases: [" 测试环境 ", "预发布"],
  });
  const valid = validateRule(current);
  assert.deepEqual(valid.valueAliases, ["测试环境", "预发布"]);
  assert.deepEqual(current.valueAliases, [" 测试环境 ", "预发布"]);
  const config = { ...emptyConfig(), rules: [valid] };
  selectRuleValue(config, {
    id: valid.id,
    environmentId: "default",
    value: "231",
  });
  assert.deepEqual(config.rules[0]!.valueAliases, ["测试环境", "预发布"]);
  assert.equal(
    compileRules(config)[0]!.action.requestHeaders![0]!.value,
    "231",
  );
  const parsed = parseRules(exportRules(config, "header"), {
    target: "header",
    conflict: "skip",
    scope: "global",
    pattern: "",
    operation: "set",
  });
  assert.deepEqual(parsed[0]!.valueAliases, ["测试环境", "预发布"]);
  const copy = updateEnvironment(structuredClone(config), {
    action: "duplicate",
    id: "default",
    name: "复制",
  });
  assert.deepEqual(copy.rules.at(-1)!.valueAliases, valid.valueAliases);
  assert.deepEqual(
    validateRule(rule({ valueAliases: ["生产"] })).valueAliases,
    ["生产"],
  );
  for (const valueAliases of [
    ["too", "many"],
    ["x".repeat(49)],
    ["bad\nline"],
    [null],
  ] as unknown as string[][]) {
    assert.throws(() => validateRule(rule({ valueAliases })), /别名/);
  }
});

test("quick add merges with latest rule, preserves flags and rejects duplicates, limits and stale context", async () => {
  const { addRuleValue } = await import("../lib/rules");
  const config = {
    ...emptyConfig(),
    rules: [
      rule({
        value: "898",
        values: ["898", "231"],
        valueAliases: ["测试", "预发布"],
        enabled: false,
      }),
    ],
  };
  const input = {
    id: "legacy-rule",
    environmentId: "default",
    value: "831",
    alias: "生产",
  };
  config.rules[0]!.pattern = "example.test";
  config.rules[0]!.scope = "domain";
  addRuleValue(config, input);
  assert.deepEqual(config.rules[0]!.values, ["898", "231", "831"]);
  assert.deepEqual(config.rules[0]!.valueAliases, ["测试", "预发布", "生产"]);
  assert.equal(config.rules[0]!.pattern, "example.test");
  assert.equal(config.rules[0]!.enabled, false);
  assert.equal(config.rules[0]!.value, "831");
  const snapshot = structuredClone(config);
  for (const invalid of [
    input,
    { ...input, environmentId: "gone", value: "832" },
    { ...input, id: "gone", value: "832" },
    { ...input, value: "bad\n" },
    { ...input, value: "832", alias: "x".repeat(49) },
  ]) {
    assert.throws(() => addRuleValue(config, invalid));
    assert.deepEqual(config, snapshot);
  }
  const many = {
    ...emptyConfig(),
    rules: [
      rule({
        value: "0",
        values: Array.from({ length: 30 }, (_, i) => String(i)),
      }),
    ],
  };
  assert.throws(() => addRuleValue(many, { ...input, value: "30" }), /1–30/);
  const f = fixture({ ...emptyConfig(), rules: [rule({ value: "898" })] });
  await f.controller.sync();
  for (const failure of ["dnr", "storage"] as const) {
    f.fail(failure);
    await assert.rejects(
      f.controller.mutate((c) => addRuleValue(c, input)),
      /failed/,
    );
    assert.equal((await f.controller.read()).rules[0]!.value, "898");
    assert.equal((await f.controller.read()).rules[0]!.values, undefined);
    assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "898");
  }
  await f.controller.mutate((c) => addRuleValue(c, input));
  const restarted = fixture(f.store[CONFIG_KEY]);
  assert.deepEqual((await restarted.controller.read()).rules[0]!.valueAliases, [
    "",
    "生产",
  ]);
});

test("inline edits change only the requested candidate field and preserve current selection", async () => {
  const f = fixture({
    ...emptyConfig(),
    rules: [
      rule({
        value: "898",
        values: ["898", "899"],
        valueAliases: ["测试", "预发布"],
      }),
    ],
  });
  const input = {
    id: "legacy-rule",
    environmentId: "default",
    value: "899",
    field: "value" as const,
    text: "900",
    previousAlias: "预发布",
  };
  await f.controller.mutate((c) => editRuleValue(c, input));
  assert.equal((await f.controller.read()).rules[0]!.value, "898");
  assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "898");
  await f.controller.mutate((c) =>
    editRuleValue(c, { ...input, value: "898", text: "901" }),
  );
  assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "901");
  await f.controller.mutate((c) => {
    c.rules[0]!.includeSubdomains = true;
    return c;
  });
  await f.controller.mutate((c) =>
    editRuleValue(c, {
      ...input,
      value: "900",
      field: "alias",
      text: "  灰度  ",
    }),
  );
  const saved = (await f.controller.read()).rules[0]!;
  assert.deepEqual(saved.values, ["901", "900"]);
  assert.deepEqual(saved.valueAliases, ["测试", "灰度"]);
  assert.equal(saved.includeSubdomains, true);
  assert.equal(saved.value, "901");
  const restarted = fixture(f.store[CONFIG_KEY]);
  assert.deepEqual((await restarted.controller.read()).rules[0]!.valueAliases, [
    "测试",
    "灰度",
  ]);
});

test("inline edits reject invalid or stale input without altering saved state", async () => {
  const initial = {
    ...emptyConfig(),
    rules: [
      rule({
        value: "898",
        values: ["898", "899"],
        valueAliases: ["测试", "预发布"],
      }),
    ],
  };
  const input = {
    id: "legacy-rule",
    environmentId: "default",
    value: "899",
    field: "value" as "value" | "alias",
    text: "900",
    previousAlias: "预发布",
  };
  const f = fixture(initial);
  await f.controller.sync();
  for (const invalid of [
    { ...input, text: "898" },
    { ...input, text: "bad\nvalue" },
    { ...input, text: "x".repeat(16001) },
    { ...input, value: "gone" },
    { ...input, environmentId: "other" },
    { ...input, id: "gone" },
    { ...input, field: "alias" as const, previousAlias: "old" },
    { ...input, field: "alias" as const, text: "x".repeat(49) },
  ]) {
    await assert.rejects(f.controller.mutate((c) => editRuleValue(c, invalid)));
    assert.equal((await f.controller.read()).rules[0]!.value, "898");
    assert.deepEqual((await f.controller.read()).rules[0]!.valueAliases, [
      "测试",
      "预发布",
    ]);
    assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "898");
  }
});

test("failed inline commits roll back; paused and disabled rules stay inactive", async () => {
  const config = {
    ...emptyConfig(),
    rules: [rule({ value: "898", values: ["898", "899"] })],
  };
  const f = fixture(config);
  await f.controller.sync();
  const input = {
    id: "legacy-rule",
    environmentId: "default",
    value: "898",
    field: "value" as const,
    text: "900",
    previousAlias: "",
  };
  for (const failure of ["dnr", "storage"] as const) {
    f.fail(failure);
    await assert.rejects(
      f.controller.mutate((c) => editRuleValue(c, input)),
      /failed/,
    );
    assert.equal((await f.controller.read()).rules[0]!.value, "898");
    assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "898");
  }
  for (const paused of [true, false]) {
    const quiet = fixture({
      ...config,
      enabled: !paused,
      rules: [{ ...config.rules[0]!, enabled: paused }],
    });
    await quiet.controller.mutate((c) => editRuleValue(c, input));
    assert.equal(quiet.installed().length, 0);
    assert.equal((await quiet.controller.read()).enabled, !paused);
    assert.equal((await quiet.controller.read()).rules[0]!.enabled, paused);
  }
});

test("inline edits support a legacy single value, empty values and clearing an alias", () => {
  const config = { ...emptyConfig(), rules: [rule({ value: "legacy" })] };
  const input = {
    id: "legacy-rule",
    environmentId: "default",
    value: "legacy",
    field: "alias" as "alias" | "value",
    text: "开发",
    previousAlias: "",
  };
  editRuleValue(config, input);
  assert.deepEqual(config.rules[0]!.values, ["legacy"]);
  editRuleValue(config, { ...input, field: "value", text: "" });
  assert.equal(config.rules[0]!.value, "");
  assert.deepEqual(config.rules[0]!.valueAliases, ["开发"]);
  editRuleValue(config, {
    ...input,
    value: "",
    text: "",
    previousAlias: "开发",
  });
  assert.deepEqual(config.rules[0]!.valueAliases, [""]);
  assert.equal(validateConfig(config).rules[0]!.value, "");
});

test("candidate deletion handles empty/current values, aligned aliases and latest metadata", () => {
  const config = {
    ...emptyConfig(),
    rules: [
      rule({
        value: "",
        values: ["898", "", "831"],
        valueAliases: ["测试", "空值", "生产"],
        enabled: false,
      }),
    ],
  };
  const input = { id: "legacy-rule", environmentId: "default", value: "831" };
  removeRuleValue(config, input);
  assert.equal(config.rules[0]!.value, "");
  assert.deepEqual(config.rules[0]!.valueAliases, ["测试", "空值"]);
  config.rules[0]!.key = "X-Latest";
  removeRuleValue(config, { ...input, value: "" });
  assert.equal(config.rules[0]!.value, "898");
  assert.deepEqual(config.rules[0]!.values, ["898"]);
  assert.deepEqual(config.rules[0]!.valueAliases, ["测试"]);
  assert.equal(config.rules[0]!.enabled, false);
  assert.equal(config.rules[0]!.key, "X-Latest");
});
test("deletion rejects stale candidate/environment and the last value atomically", () => {
  const config = {
    ...emptyConfig(),
    rules: [rule({ value: "898", values: ["898"] })],
  };
  const before = structuredClone(config);
  for (const input of [
    { id: "legacy-rule", environmentId: "default", value: "898" },
    { id: "legacy-rule", environmentId: "other", value: "898" },
    { id: "legacy-rule", environmentId: "default", value: "gone" },
    { id: "gone", environmentId: "default", value: "898" },
  ]) {
    assert.throws(() => removeRuleValue(config, input));
    assert.deepEqual(config, before);
  }
});
test("candidate deletion rolls back DNR/storage failures and preserves pause/disabled states", async () => {
  const config = {
    ...emptyConfig(),
    rules: [rule({ value: "898", values: ["898", "899"] })],
  };
  const input = { id: "legacy-rule", environmentId: "default", value: "898" };
  const f = fixture(config);
  await f.controller.sync();
  for (const failure of ["dnr", "storage"] as const) {
    f.fail(failure);
    await assert.rejects(
      f.controller.mutate((c) => removeRuleValue(c, input)),
      /failed/,
    );
    assert.equal((await f.controller.read()).rules[0]!.value, "898");
    assert.deepEqual((await f.controller.read()).rules[0]!.values, [
      "898",
      "899",
    ]);
    assert.equal(f.installed()[0]!.action.requestHeaders![0]!.value, "898");
  }
  for (const paused of [true, false]) {
    const quiet = fixture({
      ...config,
      enabled: !paused,
      rules: [{ ...config.rules[0]!, enabled: paused }],
    });
    await quiet.controller.mutate((c) => removeRuleValue(c, input));
    assert.equal(quiet.installed().length, 0);
    assert.equal((await quiet.controller.read()).rules[0]!.value, "899");
  }
});
