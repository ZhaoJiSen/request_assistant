import {
  compileRules,
  migrateLegacy,
  validateConfig,
  validateRule,
} from "./rules";
import { emptyConfig, type Config, type Rule } from "./types";
export const CONFIG_KEY = "headerManagerV2";
export function createController(api: typeof chrome) {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
  let syncError = "";
  async function read(): Promise<Config> {
    const data = await api.storage.local.get([CONFIG_KEY, "headers"]);
    if (data[CONFIG_KEY]) {
      const stored = data[CONFIG_KEY] as Config;
      const config = validateConfig(stored);
      if (!stored.environments) {
        await api.storage.local.set({
          [CONFIG_KEY]: config,
          headerManagerBeforeEnvironments: stored,
        });
      }
      return config;
    }
    const config = migrateLegacy(data.headers);
    await api.storage.local.set({
      [CONFIG_KEY]: config,
      ...(data.headers ? { headerManagerLegacyBackup: data.headers } : {}),
    });
    return config;
  }
  async function apply(config: Config) {
    const rules = compileRules(config);
    for (const rule of rules) {
      const check = await api.declarativeNetRequest.isRegexSupported({
        regex: rule.condition.regexFilter!,
        isCaseSensitive: false,
      });
      if (!check.isSupported)
        throw new Error("域名规则不受浏览器支持，请修改该规则");
    }
    const current = await api.declarativeNetRequest.getDynamicRules();
    await api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: current.map((r) => r.id),
      addRules: rules,
    });
  }
  async function commit(previous: Config, next: Config) {
    await api.storage.local.set({ headerManagerPending: next });
    try {
      await apply(next);
      await api.storage.local.set({
        [CONFIG_KEY]: next,
        headerManagerPending: null,
      });
      syncError = "";
    } catch (error) {
      try {
        await apply(previous);
        await api.storage.local.set({ headerManagerPending: null });
      } catch {
        syncError = "规则恢复失败，请点击重新同步；当前注入状态未确认";
      }
      throw error;
    }
    return next;
  }
  return {
    read,
    status: () => syncError,
    sync: () =>
      serial(async () => {
        try {
          await apply(await read());
          await api.storage.local.set({ headerManagerPending: null });
          syncError = "";
        } catch (e) {
          syncError = e instanceof Error ? e.message : "同步失败";
          throw e;
        }
      }),
    mutate: (fn: (config: Config) => Config) =>
      serial(async () => {
        const previous = await read();
        const next = validateConfig(fn(structuredClone(previous)));
        return commit(previous, next);
      }),
    saveRule: (input: Rule) =>
      serial(async () => {
        const previous = await read();
        if (
          input.environmentId &&
          input.environmentId !== previous.activeEnvironmentId
        )
          throw new Error("环境已切换，请重新打开规则编辑");
        const rule = validateRule({
          ...input,
          environmentId: previous.activeEnvironmentId,
        });
        const next = structuredClone(previous);
        const index = next.rules.findIndex((r) => r.id === rule.id);
        if (
          index >= 0 &&
          next.rules[index]!.environmentId !== previous.activeEnvironmentId
        )
          throw new Error("该规则不属于当前环境");
        if (index < 0) {
          rule.id = crypto.randomUUID();
          next.rules.push(rule);
        } else next.rules[index] = rule;
        return commit(previous, validateConfig(next));
      }),
    reset: () => serial(async () => commit(await read(), emptyConfig())),
  };
}
