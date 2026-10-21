import type { Config, EnvironmentCommand } from "./types";
import { activeRules } from "./types";

/** Mutates a controller-owned clone; the controller validates and commits it atomically. */
export function updateEnvironment(
  config: Config,
  command: EnvironmentCommand,
): Config {
  if (!command || typeof command !== "object") throw new Error("环境操作无效");
  const environment =
    "id" in command
      ? config.environments.find((e) => e.id === command.id)
      : undefined;
  if (command.action !== "create" && !environment)
    throw new Error("环境不存在，请刷新");
  switch (command.action) {
    case "switch":
      config.activeEnvironmentId = command.id;
      break;
    case "create":
    case "duplicate": {
      const id = crypto.randomUUID();
      config.environments.push({ id, name: command.name });
      if (command.action === "duplicate") {
        const source = { ...config, activeEnvironmentId: command.id };
        const rules = activeRules(source).map((rule) => ({
          ...rule,
          id: crypto.randomUUID(),
          environmentId: id,
        }));
        config.rules.push(...rules);
      }
      config.activeEnvironmentId = id;
      break;
    }
    case "rename":
      environment!.name = command.name;
      break;
    case "delete":
      if (config.environments.length === 1) throw new Error("至少保留一个环境");
      config.environments = config.environments.filter(
        (e) => e.id !== command.id,
      );
      config.rules = config.rules.filter((r) => r.environmentId !== command.id);
      if (config.activeEnvironmentId === command.id)
        config.activeEnvironmentId = config.environments[0]!.id;
      break;
    default:
      throw new Error("不支持的环境操作");
  }
  return config;
}
