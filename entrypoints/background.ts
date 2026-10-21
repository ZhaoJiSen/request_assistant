import { defineBackground } from "wxt/utils/define-background";
import { importCookies } from "../lib/cookie-transfer";
import { importRules, type ImportRequest } from "../lib/transfer";
import { createController } from "../lib/controller";
import { updateEnvironment } from "../lib/environments";
import {
  currentContext,
  listCookies,
  removeCookie,
  writeCookie,
} from "../lib/cookies";
import {
  activeRules,
  type CookieInput,
  type EnvironmentCommand,
  type Request,
  type Rule,
} from "../lib/types";
export default defineBackground(() => {
  const controller = createController(chrome);
  let cookieQueue: Promise<unknown> = Promise.resolve();
  const ready = controller.sync().catch(() => {});
  chrome.runtime.onStartup.addListener(() => {
    void controller.sync().catch(() => {});
  });
  chrome.runtime.onInstalled.addListener(() => {
    void controller.sync().catch(() => {});
  });
  async function state() {
    return {
      config: await controller.read(),
      syncError: controller.status(),
      dynamicRuleCount: (await chrome.declarativeNetRequest.getDynamicRules())
        .length,
    };
  }
  async function route(message: Request) {
    await ready;
    switch (message.type) {
      case "CONTEXT":
        return currentContext(chrome);
      case "STATE":
        return state();
      case "SYNC":
        await controller.sync();
        return state();
      case "IMPORT_RULES":
        await controller.mutate((c) =>
          importRules(c, message.payload as ImportRequest),
        );
        return state();
      case "IMPORT_COOKIES": {
        const run = cookieQueue.then(() =>
          importCookies(chrome, message.payload as ImportRequest),
        );
        cookieQueue = run.catch(() => {});
        return run;
      }
      case "SAVE_RULE":
        await controller.saveRule(message.payload as Rule);
        return state();
      case "ENVIRONMENT":
        await controller.mutate((c) =>
          updateEnvironment(c, message.payload as EnvironmentCommand),
        );
        return state();
      case "TOGGLE_ALL": {
        if (typeof message.payload !== "boolean")
          throw new Error("开关参数无效");
        await controller.mutate((c) => ({
          ...c,
          enabled: message.payload as boolean,
        }));
        return state();
      }
      case "TOGGLE_RULE": {
        await controller.mutate((c) => {
          const rule = activeRules(c).find((r) => r.id === message.payload);
          if (!rule) throw new Error("规则不存在，请刷新");
          rule.enabled = !rule.enabled;
          return c;
        });
        return state();
      }
      case "DELETE_RULE":
        await controller.mutate((c) => {
          if (!activeRules(c).some((r) => r.id === message.payload))
            throw new Error("当前环境中找不到该规则");
          return {
            ...c,
            rules: c.rules.filter((r) => r.id !== message.payload),
          };
        });
        return state();
      case "COOKIES":
      case "WRITE_COOKIE":
      case "DELETE_COOKIE": {
        const context = await currentContext(chrome);
        if (!context) throw new Error("请先打开一个 HTTP / HTTPS 网站");
        // Bind every action to the tab shown to the user; switching tabs cannot redirect a write.
        const payload = message.payload as {
          url: string;
          cookie?: chrome.cookies.Cookie;
          input?: CookieInput;
        };
        if (payload.url !== context.url)
          throw new Error("当前网站已变化，请重新打开插件");
        if (message.type === "COOKIES") return listCookies(chrome, context);
        const run = cookieQueue.then(async () => {
          if (message.type === "WRITE_COOKIE")
            await writeCookie(chrome, context, payload.input!);
          else await removeCookie(chrome, context, payload.cookie!);
          return listCookies(chrome, context);
        });
        cookieQueue = run.catch(() => {});
        return run;
      }
      default:
        throw new Error("不支持的操作");
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    route(message)
      .then((data) => respond({ ok: true, data }))
      .catch((e) =>
        respond({
          ok: false,
          error: e instanceof Error ? e.message : "操作失败",
        }),
      );
    return true;
  });
});
