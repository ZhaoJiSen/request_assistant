export type RuleKind = "header" | "cookie";
export interface Rule {
  id: string;
  environmentId?: string;
  kind: RuleKind;
  key: string;
  value: string;
  /** Optional Header choices; value is the currently selected choice. */
  values?: string[];
  enabled: boolean;
  scope: "global" | "domain" | "regex";
  pattern: string;
  includeSubdomains: boolean;
  operation: "set" | "append";
}
export interface Config {
  version: 2;
  enabled: boolean;
  rules: Rule[];
  environments: Environment[];
  activeEnvironmentId: string;
}
export interface Environment {
  id: string;
  name: string;
}
export type EnvironmentCommand =
  | { action: "create"; name: string }
  | { action: "duplicate"; name: string; id: string }
  | { action: "rename"; name: string; id: string }
  | { action: "switch" | "delete"; id: string };
export const DEFAULT_ENVIRONMENT_ID = "default";
export const activeRules = (config: Config): Rule[] =>
  config.rules.filter(
    (r) =>
      (r.environmentId || DEFAULT_ENVIRONMENT_ID) ===
      (config.activeEnvironmentId || DEFAULT_ENVIRONMENT_ID),
  );
export interface Context {
  url: string;
  hostname: string;
  host: string;
  tabId?: number;
  storeId?: string;
  partitionKey?: chrome.cookies.CookiePartitionKey;
}
export interface State {
  config: Config;
  syncError: string;
  dynamicRuleCount: number;
}
export interface CookieInput {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: `${chrome.cookies.SameSiteStatus}`;
  expirationDate?: number;
  partitionKey?: chrome.cookies.CookiePartitionKey;
  original?: chrome.cookies.Cookie;
}
export interface Request {
  type: string;
  payload?: unknown;
}
export const emptyConfig = (): Config => ({
  version: 2,
  enabled: true,
  rules: [],
  environments: [{ id: DEFAULT_ENVIRONMENT_ID, name: "默认环境" }],
  activeEnvironmentId: DEFAULT_ENVIRONMENT_ID,
});
