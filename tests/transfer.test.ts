import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cookieSnapshot,
  exportCookies,
  exportRules,
  importRules,
  parseCookies,
  parseRules,
  planRules,
  ruleSnapshot,
  type ImportOptions,
  type ImportRequest,
} from "../lib/transfer";
import { importCookies } from "../lib/cookie-transfer";
import { emptyConfig, type Context, type Config } from "../lib/types";
const context: Context = {
  url: "https://app.example.com/orders",
  hostname: "app.example.com",
  host: "app.example.com",
  storeId: "0",
  tabId: 1,
};
const options: ImportOptions = {
  target: "header",
  conflict: "skip",
  scope: "domain",
  pattern: context.host,
  operation: "set",
};
const payload = (
  c: Config,
  text: string,
  extra: Partial<ImportRequest> = {},
): ImportRequest => ({
  ...options,
  text,
  environmentId: c.activeEnvironmentId,
  expected: ruleSnapshot(c),
  ...extra,
});
test("Header text and JSON preserve colons/empty values; invalid lines, duplicates and mixed kinds are rejected", () => {
  const rows = parseRules(
    "Authorization: Bearer abc:def\nX-Empty:\r\nX-Env: staging",
    options,
  );
  assert.deepEqual(
    rows.map((r) => r.value),
    ["Bearer abc:def", "", "staging"],
  );
  assert.equal(parseRules('{"X-A":"1"}', options)[0]!.key, "X-A");
  for (const text of [
    "X-A: 1\nx-a: 2",
    "X-A: 1\nInvalid",
    "{bad}",
    '{"X-A":7}',
    '[{"kind":"cookie","key":"Cookie","value":"a=b"}]',
    "X-A: a\u0000b",
  ])
    assert.throws(() => parseRules(text, options));
  assert.throws(
    () => parseRules("X-A: " + "a".repeat(1024 * 1024), options),
    /1 MB/,
  );
});
test("rule import skips or replaces by scope in the active group, preserves IDs and disabled values across export round trips", () => {
  const c = emptyConfig();
  c.rules = [
    {
      ...parseRules("X-A: old", options)[0]!,
      id: "keep",
      environmentId: "default",
      enabled: false,
    },
  ];
  c.environments.push({ id: "other", name: "另一环境" });
  c.rules.push({ ...c.rules[0]!, id: "other-id", environmentId: "other" });
  let next = importRules(
    structuredClone(c),
    payload(c, "X-A: new\nX-B: added"),
  );
  assert.equal(next.rules.find((r) => r.id === "keep")!.value, "old");
  assert.equal(next.rules.length, 3);
  next = importRules(
    structuredClone(c),
    payload(c, "X-A: new", { conflict: "replace" }),
  );
  assert.equal(next.rules.find((r) => r.id === "keep")!.value, "new");
  assert.equal(next.rules.find((r) => r.id === "other-id")!.value, "old");
  const roundtrip = importRules(
    emptyConfig(),
    payload(emptyConfig(), exportRules(c, "header")),
  );
  assert.equal(roundtrip.rules.length, 1);
  assert.equal(roundtrip.rules[0]!.enabled, false);
  assert.notEqual(roundtrip.rules[0]!.id, "keep");
  assert.throws(
    () => importRules(c, payload(c, "X-C: value", { environmentId: "other" })),
    /已变化/,
  );
  assert.throws(
    () => importRules(c, payload(c, "X-C: value", { expected: "stale" })),
    /已变化/,
  );
});
test("request Cookie imports form one rule, preserve equals and export injection operation", () => {
  const o = {
    ...options,
    target: "cookie",
    operation: "append",
  } as ImportOptions;
  const rows = parseRules("Cookie: token=a=b; tenant=sh;", o);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.value, "token=a=b; tenant=sh");
  assert.equal(rows[0]!.operation, "append");
  assert.throws(() => parseRules("foo; bar=a", o));
  assert.throws(() => parseRules(exportCookies([]), o), /类型/);
});
test("Cookie JSON round trip preserves host/domain, HttpOnly, expiry and partition metadata; rejects unrelated domains and unsafe values before writing", () => {
  const cookies = [
    {
      name: "sid",
      value: "a=b",
      domain: ".example.com",
      path: "/api",
      hostOnly: false,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      session: false,
      expirationDate: Date.now() / 1000 + 86400,
      storeId: "0",
    },
  ] as chrome.cookies.Cookie[];
  const parsed = parseCookies(exportCookies(cookies), context)[0]!;
  assert.equal(parsed.httpOnly, true);
  assert.equal(parsed.path, "/api");
  assert.equal(parsed.hostOnly, false);
  assert.equal(parsed.expirationDate, cookies[0]!.expirationDate);
  assert.equal(parseCookies("sid=abc==; tenant=sh", context).length, 2);
  const key = {
    topLevelSite: "https://example.com",
    hasCrossSiteAncestor: false,
  };
  const partitioned = {
    ...cookies[0],
    domain: context.hostname,
    hostOnly: true,
    partitionKey: key,
  };
  assert.deepEqual(
    parseCookies(JSON.stringify([partitioned]), {
      ...context,
      partitionKey: key,
    })[0]!.partitionKey,
    key,
  );
  for (const input of [
    { domain: "elsewhere.test" },
    { path: "no-slash" },
    { value: "bad;value" },
    { name: "bad name" },
    { sameSite: "no_restriction", secure: false },
    { expirationDate: 0 },
    { secure: "false" },
    { partitionKey: key },
  ])
    assert.throws(() =>
      parseCookies(
        JSON.stringify([{ name: "sid", value: "abc", ...input }]),
        context,
      ),
    );
  assert.throws(() => parseCookies("a=1; a=2", context), /同名/);
});
function cookieApi() {
  let cookies: chrome.cookies.Cookie[] = [];
  const writes: any[] = [];
  let failName = "";
  const api = {
    tabs: { query: async () => [{ id: 1, url: context.url }] },
    cookies: {
      getAllCookieStores: async () => [{ id: "0", tabIds: [1] }],
      getPartitionKey: async () => ({}),
      getAll: async () => structuredClone(cookies),
      set: async (input: any) => {
        writes.push(input);
        if (input.name === failName) throw new Error("browser rejected");
        const c = {
          ...input,
          domain: input.domain ?? new URL(input.url).hostname,
          hostOnly: !input.domain,
          session: input.expirationDate === undefined,
        };
        const i = cookies.findIndex(
          (v) =>
            v.name === c.name && v.domain === c.domain && v.path === c.path,
        );
        if (i < 0) cookies.push(c);
        else cookies[i] = c;
        return c;
      },
    },
  } as unknown as typeof chrome;
  return {
    api,
    writes,
    read: () => cookies,
    fail: (name: string) => {
      failName = name;
    },
  };
}
test("Cookie bulk preflight causes zero writes for invalid/stale input; partial browser failures retain only failed inputs for retry", async () => {
  const f = cookieApi();
  const p = {
    ...payload(emptyConfig(), "one=1; two=2"),
    target: "site",
    url: context.url,
    expected: cookieSnapshot([]),
  } as ImportRequest;
  await assert.rejects(
    importCookies(f.api, {
      ...p,
      text: JSON.stringify([
        { name: "one", value: "1" },
        { name: "two", value: "2", domain: "evil.test" },
      ]),
    }),
  );
  assert.equal(f.writes.length, 0);
  await assert.rejects(
    importCookies(f.api, { ...p, expected: "stale" }),
    /已变化/,
  );
  assert.equal(f.writes.length, 0);
  f.fail("two");
  const result = await importCookies(f.api, p);
  assert.equal(result.imported, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.name, "two");
  assert.equal(result.cookies[0]!.name, "one");
  f.fail("");
  const retry = await importCookies(f.api, {
    ...p,
    text: JSON.stringify(result.failed.map((r) => r.input)),
    expected: cookieSnapshot(result.cookies),
  });
  assert.equal(retry.imported, 1);
  assert.equal(retry.failed.length, 0);
  assert.equal(f.read().length, 2);
  const skipped = await importCookies(f.api, {
    ...p,
    expected: cookieSnapshot(f.read()),
  });
  assert.equal(skipped.skipped, 2);
  assert.equal(skipped.imported, 0);
  f.read()[0]!.httpOnly = true;
  f.read()[0]!.expirationDate = Date.now() / 1000 + 86400;
  const replaced = await importCookies(f.api, {
    ...p,
    text: "one=updated",
    conflict: "replace",
    expected: cookieSnapshot(f.read()),
  });
  assert.equal(replaced.imported, 1);
  assert.equal(
    replaced.cookies.find((c) => c.name === "one")!.value,
    "updated",
  );
  assert.equal(replaced.cookies.find((c) => c.name === "one")!.httpOnly, true);
  assert.ok(
    replaced.cookies.find((c) => c.name === "one")!.expirationDate! >
      Date.now() / 1000,
  );
});
test("all-group rule limit is enforced without changing installed or saved configuration on a failed batch", async () => {
  // Same commit path used by background imports, including DNR/storage rollback.
  const { createController, CONFIG_KEY } = await import("../lib/controller");
  const config = emptyConfig();
  config.rules = Array.from({ length: 500 }, (_, i) => ({
    ...parseRules(`X-${i}: a`, options)[0]!,
    id: `r${i}`,
    environmentId: "default",
  }));
  const store = { [CONFIG_KEY]: structuredClone(config) };
  let dnr: any[] = [];
  let failStorage = false;
  const api = {
    storage: {
      local: {
        get: async () => structuredClone(store),
        set: async (v: any) => {
          if (failStorage && v[CONFIG_KEY]) {
            failStorage = false;
            throw new Error("storage failed");
          }
          Object.assign(store, structuredClone(v));
        },
      },
    },
    declarativeNetRequest: {
      isRegexSupported: async () => ({ isSupported: true }),
      getDynamicRules: async () => dnr,
      updateDynamicRules: async (v: any) => {
        dnr = v.addRules;
      },
    },
  } as unknown as typeof chrome;
  const c = createController(api);
  await c.sync();
  const before = await c.read();
  await assert.rejects(
    c.mutate((current) => importRules(current, payload(before, "X-New: b"))),
    /500/,
  );
  assert.deepEqual(await c.read(), before);
  assert.equal(dnr.length, 500);
  failStorage = true;
  await assert.rejects(
    c.mutate((current) =>
      importRules(
        current,
        payload(before, "X-0: changed", { conflict: "replace" }),
      ),
    ),
    /storage failed/,
  );
  assert.deepEqual(await c.read(), before);
  assert.equal(dnr[0].action.requestHeaders[0].value, "a");
});
