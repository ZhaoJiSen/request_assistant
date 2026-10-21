<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Cookie,
  Eye,
  EyeOff,
  Download,
  Upload,
  Globe2,
  Info,
  Layers,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-vue-next";
import { request, isPreview } from "../../lib/client";
import UiSelect from "./components/UiSelect.vue";
import TransferPanel from "./components/TransferPanel.vue";
import type { TransferTarget } from "../../lib/transfer";
import EnvironmentManager from "./components/EnvironmentManager.vue";
import { matchesRule, validateRule } from "../../lib/rules";
import {
  emptyConfig,
  activeRules,
  type EnvironmentCommand,
  type Context,
  type CookieInput,
  type Rule,
  type RuleKind,
  type State,
} from "../../lib/types";
type Tab = "header" | "cookie" | "site";
const tab = ref<Tab>(
  new URLSearchParams(location.search).get("state") === "cookies"
    ? "site"
    : new URLSearchParams(location.search).get("state") === "request"
      ? "cookie"
      : "header",
);
const tabs: { id: Tab; name: string }[] = [
  { id: "header", name: "Header" },
  { id: "cookie", name: "请求 Cookie" },
  { id: "site", name: "网站 Cookie" },
];
const state = ref<State>({
  config: emptyConfig(),
  syncError: "",
  dynamicRuleCount: 0,
});
const context = ref<Context | null>(null);
const cookies = ref<chrome.cookies.Cookie[]>([]);
const loading = ref(true);
const busy = ref(false);
const cookieLoading = ref(false);
const error = ref("");
const notice = ref("");
const query = ref("");
const scopeFilter = ref("all");
const revealed = reactive(new Set<string>());
const confirmDelete = ref("");
const editor = ref<"rule" | "site" | "environments" | "transfer" | null>(null);
const editorError = ref("");
const transferMode = ref<"import" | "export">("import");
const transferTarget = ref<TransferTarget>("header");
const form = reactive<Rule>({
  id: "",
  kind: "header",
  key: "",
  value: "",
  enabled: true,
  scope: "domain",
  pattern: "",
  includeSubdomains: true,
  operation: "set",
});
const cookieForm = reactive<CookieInput>({
  name: "",
  value: "",
  domain: "",
  path: "/",
  hostOnly: true,
  secure: true,
  httpOnly: false,
  sameSite: "lax",
});
const expiry = ref("");
const advanced = ref(false);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const siteCookieId = (c: chrome.cookies.Cookie) =>
  JSON.stringify([c.name, c.domain, c.path, c.partitionKey, c.storeId]);
const currentRules = computed(() => activeRules(state.value.config));
const environmentOptions = computed(() =>
  state.value.config.environments.map((e) => ({ value: e.id, label: e.name })),
);
const filterOptions = computed(() => [
  { value: "all", label: "全部规则" },
  { value: "current", label: "当前网站", disabled: !context.value },
]);
const scopeOptions = computed(() => [
  { value: "domain", label: "指定网站" },
  { value: "global", label: "所有网站" },
  ...(form.scope === "regex"
    ? [{ value: "regex", label: "旧版域名正则" }]
    : []),
]);
const enabledCount = computed(
  () => currentRules.value.filter((r) => r.enabled).length,
);
const matchedCount = computed(() =>
  state.value.config.enabled && context.value
    ? currentRules.value.filter(
        (r) => r.enabled && matchesRule(r, context.value!.url),
      ).length
    : 0,
);
const allKindRules = computed(() =>
  currentRules.value.filter((r) => r.kind === tab.value),
);
const filteredRules = computed(() =>
  allKindRules.value.filter(
    (r) =>
      (scopeFilter.value !== "current" ||
        (context.value && matchesRule(r, context.value.url))) &&
      `${r.key} ${r.value} ${r.pattern}`
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
const filteredCookies = computed(() =>
  cookies.value.filter((c) =>
    `${c.name} ${c.value} ${c.domain} ${c.path}`
      .toLowerCase()
      .includes(query.value.toLowerCase()),
  ),
);
const listCount = computed(() =>
  tab.value === "site" ? cookies.value.length : allKindRules.value.length,
);
const tabIndex = computed(() => tabs.findIndex((t) => t.id === tab.value));
const isSensitive = (r: Rule) =>
  r.kind === "cookie" ||
  /authorization|token|secret|password|api[-_]?key/i.test(r.key);
function flash(message: string) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = "";
  }, 3000);
}
async function run(fn: () => Promise<void>, local = false) {
  if (busy.value) return;
  busy.value = true;
  if (local) editorError.value = "";
  else error.value = "";
  try {
    await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : "操作失败，请重试";
    if (local) {
      editorError.value = message;
      await nextTick();
      document
        .querySelector(".editor-error")
        ?.scrollIntoView({ block: "nearest" });
    } else error.value = message;
  } finally {
    busy.value = false;
  }
}
async function loadCookies() {
  if (!context.value) return;
  cookieLoading.value = true;
  try {
    cookies.value = await request("COOKIES", { url: context.value.url });
  } finally {
    cookieLoading.value = false;
  }
}
async function changeTab(id: Tab) {
  tab.value = id;
  query.value = "";
  confirmDelete.value = "";
  error.value = "";
  if (id === "site") {
    try {
      await loadCookies();
    } catch (e) {
      error.value = e instanceof Error ? e.message : "读取 Cookie 失败";
    }
  }
}
async function initialize() {
  loading.value = true;
  try {
    [context.value, state.value] = await Promise.all([
      request<Context | null>("CONTEXT"),
      request<State>("STATE"),
    ]);
    if (tab.value === "site") await loadCookies();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败，请重试";
  } finally {
    loading.value = false;
  }
}
function scopeName(r: Rule) {
  return r.scope === "global"
    ? "所有网站"
    : r.scope === "regex"
      ? `旧版正则 · ${r.pattern}`
      : `${r.pattern}${r.includeSubdomains ? " 及子域" : ""}`;
}
function matching(r: Rule) {
  return context.value && matchesRule(r, context.value.url);
}
function toggleReveal(id: string) {
  if (revealed.has(id)) revealed.delete(id);
  else revealed.add(id);
}
const editorReturnFocus = ref<HTMLElement | null>(null);
async function focusEditor() {
  notice.value = "";
  editorReturnFocus.value = document.activeElement as HTMLElement;
  await nextTick();
  document
    .querySelector<HTMLElement>(
      ".editor input:not([disabled]):not([type=file]), .editor textarea:not([disabled]), .environment-manager .environment-choice, .export-copy",
    )
    ?.focus();
}
async function openTransfer(mode: "import" | "export") {
  await run(async () => {
    state.value = await request<State>("STATE");
    if (tab.value === "site") await loadCookies();
    transferMode.value = mode;
    transferTarget.value = tab.value;
    editor.value = "transfer";
    void focusEditor();
  });
}
function transferDone(message: string) {
  editor.value = null;
  flash(message);
  void nextTick(() =>
    document.querySelector<HTMLElement>(".import-button")?.focus(),
  );
}
function openEnvironments() {
  editor.value = "environments";
  editorError.value = "";
  void focusEditor();
}
async function changeEnvironment(command: EnvironmentCommand) {
  if (busy.value) throw new Error("正在处理，请稍后");
  notice.value = "";
  busy.value = true;
  try {
    state.value = await request<State>("ENVIRONMENT", command);
    query.value = "";
    revealed.clear();
    confirmDelete.value = "";
    const name = state.value.config.environments.find(
      (e) => e.id === state.value.config.activeEnvironmentId,
    )!.name;
    if (editor.value !== "environments")
      flash(
        command.action === "rename"
          ? "环境名称已更新"
          : command.action === "delete"
            ? "环境已删除"
            : `已切换到「${name}」`,
      );
  } finally {
    busy.value = false;
  }
}
async function selectEnvironment(id: string) {
  try {
    await changeEnvironment({ action: "switch", id });
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "环境切换失败";
  }
}
function openRule(rule?: Rule) {
  Object.assign(
    form,
    rule
      ? { ...rule }
      : {
          id: "",
          environmentId: state.value.config.activeEnvironmentId,
          kind: tab.value as RuleKind,
          key: tab.value === "cookie" ? "Cookie" : "",
          value: "",
          enabled: true,
          scope: context.value ? "domain" : "global",
          pattern: context.value?.host || "",
          includeSubdomains: true,
          operation: "set",
        },
  );
  editor.value = "rule";
  editorError.value = "";
  advanced.value = false;
  void focusEditor();
}
function openCookie(cookie?: chrome.cookies.Cookie) {
  if (!context.value) return;
  Object.assign(cookieForm, {
    name: cookie?.name || "",
    value: cookie?.value || "",
    domain: cookie?.domain || context.value.hostname,
    path: cookie?.path || "/",
    hostOnly: cookie?.hostOnly ?? true,
    secure: cookie?.secure ?? context.value.url.startsWith("https:"),
    httpOnly: cookie?.httpOnly ?? false,
    sameSite: cookie?.sameSite || "lax",
    expirationDate: cookie?.expirationDate,
    original: cookie,
  });
  expiry.value = cookie?.expirationDate
    ? new Date(
        cookie.expirationDate * 1000 - new Date().getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  editor.value = "site";
  editorError.value = "";
  advanced.value = false;
  void focusEditor();
}
function closeEditor() {
  if (!busy.value && editor.value) {
    editor.value = null;
    editorError.value = "";
    void nextTick(() => {
      const target = editorReturnFocus.value;
      if (target?.isConnected) target.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>(".add-button")?.focus();
    });
  }
}
async function save() {
  await run(async () => {
    if (editor.value === "rule") {
      const value = validateRule({ ...form });
      state.value = await request<State>("SAVE_RULE", value);
      flash(
        state.value.config.enabled && value.enabled
          ? "规则已保存，后续匹配请求将使用新配置"
          : "规则已保存，当前未开启注入",
      );
    } else {
      if (!context.value) throw new Error("请先打开网站");
      cookies.value = await request("WRITE_COOKIE", {
        url: context.value.url,
        input: {
          ...cookieForm,
          expirationDate: expiry.value
            ? new Date(expiry.value).getTime() / 1000
            : undefined,
        },
      });
      flash("Cookie 已写入并读回验证");
    }
    editor.value = null;
  }, true);
}
async function toggleAll() {
  await run(async () => {
    state.value = await request("TOGGLE_ALL", !state.value.config.enabled);
    flash(
      state.value.config.enabled
        ? "请求注入已开启"
        : "请求注入已暂停，网站 Cookie 保留",
    );
  });
}
async function toggleRule(rule: Rule) {
  await run(async () => {
    state.value = await request("TOGGLE_RULE", rule.id);
  });
}
async function deleteRule(rule: Rule) {
  await run(async () => {
    state.value = await request("DELETE_RULE", rule.id);
    confirmDelete.value = "";
    flash("规则已删除");
  });
}
async function deleteCookie(cookie: chrome.cookies.Cookie) {
  await run(async () => {
    cookies.value = await request("DELETE_COOKIE", {
      url: context.value!.url,
      cookie,
    });
    confirmDelete.value = "";
    flash("Cookie 已删除");
  });
}
async function refresh() {
  await run(async () => {
    if (tab.value === "site") {
      await loadCookies();
      flash("已重新读取网站 Cookie");
    } else {
      state.value = await request("SYNC");
      flash("规则已重新同步");
    }
  });
}
function tabKeydown(e: KeyboardEvent, index: number) {
  const next =
    e.key === "ArrowRight"
      ? (index + 1) % tabs.length
      : e.key === "ArrowLeft"
        ? (index + tabs.length - 1) % tabs.length
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? tabs.length - 1
            : -1;
  if (next < 0) return;
  e.preventDefault();
  const id = tabs[next]!.id;
  void changeTab(id);
  document.getElementById(`tab-${id}`)?.focus();
}
function keydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    closeEditor();
    confirmDelete.value = "";
  }
  if (e.key === "Tab" && editor.value) {
    const nodes = [
      ...document.querySelectorAll<HTMLElement>(
        ".editor button:not([disabled]), .editor input:not([disabled]):not([type=file]), .editor textarea:not([disabled])",
      ),
    ];
    const first = nodes[0];
    const last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      last?.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first?.focus();
      e.preventDefault();
    }
  }
}
let changeTimer: ReturnType<typeof setTimeout> | undefined;
function cookieChanged() {
  if (tab.value === "site" && !editor.value) {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      void loadCookies().catch(() => {});
    }, 180);
  }
}
onMounted(() => {
  void initialize();
  document.addEventListener("keydown", keydown);
  if (!isPreview) chrome.cookies.onChanged.addListener(cookieChanged);
});
onUnmounted(() => {
  clearTimeout(noticeTimer);
  clearTimeout(changeTimer);
  document.removeEventListener("keydown", keydown);
  if (!isPreview) chrome.cookies.onChanged.removeListener(cookieChanged);
});
</script>

<template>
  <main class="app-shell">
    <div class="main-view" :inert="editor ? true : undefined">
      <header class="app-header">
        <div class="brand">
          <span class="brand-symbol"
            ><Settings2 :size="21" :stroke-width="1.7"
          /></span>
          <h1>请求助手</h1>
        </div>
        <div class="environment-controls">
          <UiSelect
            class="environment-picker"
            :model-value="state.config.activeEnvironmentId"
            :options="environmentOptions"
            label="当前环境"
            :disabled="busy || loading"
            @update:model-value="selectEnvironment"
          >
            <template #leading><Layers :size="14" /></template>
          </UiSelect>
          <button
            type="button"
            class="icon-button manage-environments"
            aria-label="管理环境"
            title="管理环境"
            :disabled="busy || loading"
            @click="openEnvironments"
          >
            <Settings2 :size="16" />
          </button>
        </div>
        <button
          class="master-control"
          :disabled="busy || loading"
          :aria-pressed="state.config.enabled"
          aria-label="请求注入总开关"
          @click="toggleAll"
        >
          <span>{{ state.config.enabled ? "注入已开启" : "注入已暂停" }}</span
          ><span class="switch" :class="{ on: state.config.enabled }"
            ><span
          /></span>
        </button>
      </header>
      <section class="site-context" aria-label="当前网站">
        <span class="site-icon"><Globe2 :size="19" /></span>
        <div class="site-text">
          <span class="context-label">{{
            context ? "当前网站" : "当前页面"
          }}</span
          ><strong :title="context?.url">{{
            context?.host || "请切换到网站页面"
          }}</strong>
        </div>
        <span
          v-if="context"
          class="match-summary"
          title="按当前页面 URL 计算匹配规则，不代表实际请求命中次数"
          ><span
            class="status-dot"
            :class="{ muted: !matchedCount || state.syncError }"
          />{{ state.syncError ? "同步异常" : `${matchedCount} 条匹配` }}</span
        >
      </section>
      <nav class="tab-bar" role="tablist" aria-label="配置类型">
        <span
          class="tab-indicator"
          :style="{ transform: `translateX(${tabIndex * 100}%)` }"
        />
        <button
          v-for="(item, index) in tabs"
          :id="`tab-${item.id}`"
          :key="item.id"
          role="tab"
          :aria-selected="tab === item.id"
          :tabindex="tab === item.id ? 0 : -1"
          :class="{ selected: tab === item.id }"
          aria-controls="content-panel"
          @keydown="tabKeydown($event, index)"
          @click="changeTab(item.id)"
        >
          {{ item.name }}
        </button>
      </nav>
      <div v-if="error || state.syncError" class="error-banner" role="alert">
        <Info :size="16" /><span>{{ error || state.syncError }}</span
        ><button class="icon-button" aria-label="重新尝试" @click="initialize">
          <RefreshCw :size="15" />
        </button>
      </div>
      <section
        id="content-panel"
        class="content-panel"
        role="tabpanel"
        :aria-labelledby="`tab-${tab}`"
      >
        <div class="section-heading">
          <div class="section-title">
            <h2>
              {{
                tab === "header"
                  ? "请求 Header"
                  : tab === "cookie"
                    ? "Cookie 注入"
                    : "网站 Cookie"
              }}
            </h2>
            <span class="count">{{ listCount }}</span>
          </div>
          <div class="section-actions">
            <button
              class="text-button import-button"
              :disabled="
                busy ||
                loading ||
                (tab === 'site' && (!context || cookieLoading))
              "
              @click="openTransfer('import')"
            >
              <Upload :size="14" />导入
            </button>
            <button
              class="text-button export-button"
              :disabled="
                busy ||
                loading ||
                !listCount ||
                (tab === 'site' && (!context || cookieLoading))
              "
              @click="openTransfer('export')"
            >
              <Download :size="14" />导出
            </button>
            <button
              class="primary-button compact add-button"
              :disabled="busy || loading || (tab === 'site' && !context)"
              @click="tab === 'site' ? openCookie() : openRule()"
            >
              <Plus :size="16" />{{
                tab === "site" ? "写入 Cookie" : "添加规则"
              }}
            </button>
          </div>
        </div>
        <p v-if="tab === 'cookie'" class="section-note">
          <Info :size="15" />仅修改请求头，不会写入网站 Cookie。
        </p>
        <p v-if="tab === 'site'" class="section-note">
          <Info :size="15" />实际存储在浏览器中，不受注入总开关影响。
        </p>
        <div class="filter-row">
          <label class="search-field"
            ><Search :size="15" /><input
              v-model="query"
              aria-label="搜索配置"
              :placeholder="
                tab === 'site' ? '搜索 Cookie' : '搜索名称、值或域名'
              " /><button
              v-if="query"
              class="clear-search"
              aria-label="清空搜索"
              @click="query = ''"
            >
              <X :size="14" /></button
          ></label>
          <UiSelect
            v-if="tab !== 'site'"
            class="filter-select"
            v-model="scopeFilter"
            :options="filterOptions"
            label="筛选规则范围"
            :disabled="busy || loading"
          />
          <button
            v-else
            class="icon-button refresh-cookies"
            aria-label="刷新 Cookie"
            :disabled="busy || cookieLoading || !context"
            @click="refresh"
          >
            <RefreshCw :size="16" :class="{ spinning: cookieLoading }" />
          </button>
        </div>
        <div v-if="loading" class="empty-state" role="status">
          <RefreshCw class="spinning" :size="24" />
          <p>正在读取配置</p>
        </div>
        <div v-else-if="tab !== 'site'" class="rule-list">
          <div v-if="!filteredRules.length" class="empty-state">
            <span class="empty-symbol"><Settings2 :size="25" /></span>
            <h3>
              {{
                query || scopeFilter === "current"
                  ? "没有匹配的规则"
                  : tab === "header"
                    ? "添加第一条 Header 规则"
                    : "添加第一条 Cookie 规则"
              }}
            </h3>
            <p>
              {{
                query
                  ? "试试其他关键词。"
                  : scopeFilter === "current"
                    ? "当前网站还没有匹配的配置。"
                    : tab === "header"
                      ? "设置 Authorization 或自定义请求头。"
                      : "为发出的请求替换或追加 Cookie。"
              }}
            </p>
          </div>
          <article
            v-for="rule in filteredRules"
            :key="rule.id"
            class="rule-row"
            :class="{ disabled: !rule.enabled || !state.config.enabled }"
          >
            <button
              class="row-toggle"
              :disabled="busy"
              :aria-label="`${rule.enabled ? '停用' : '启用'} ${rule.key}`"
              :aria-pressed="rule.enabled"
              @click="toggleRule(rule)"
            >
              <span class="switch small" :class="{ on: rule.enabled }"
                ><span
              /></span>
            </button>
            <button
              class="rule-content"
              :aria-label="`编辑 ${rule.key}`"
              @click="openRule(rule)"
            >
              <span class="rule-name"
                >{{ rule.key
                }}<span v-if="rule.kind === 'cookie'" class="operation-label">{{
                  rule.operation === "set" ? "替换整段" : "追加"
                }}</span></span
              ><span class="rule-value">{{
                isSensitive(rule) && !revealed.has(rule.id)
                  ? "••••••••••••••••••••"
                  : rule.value || "（空值）"
              }}</span
              ><span class="rule-scope"
                ><Globe2 :size="12" /><span :title="scopeName(rule)">{{
                  scopeName(rule)
                }}</span
                ><span
                  v-if="
                    context &&
                    matching(rule) &&
                    rule.enabled &&
                    state.config.enabled &&
                    !state.syncError
                  "
                  class="matched-label"
                  >当前匹配</span
                ></span
              >
            </button>
            <div class="row-actions">
              <button
                class="icon-button"
                :aria-label="`编辑规则 ${rule.key}`"
                title="编辑规则"
                @click="openRule(rule)"
              >
                <Pencil :size="15" /></button
              ><button
                v-if="isSensitive(rule)"
                class="icon-button"
                :aria-label="`${revealed.has(rule.id) ? '隐藏' : '显示'} ${rule.key} 的值`"
                @click="toggleReveal(rule.id)"
              >
                <EyeOff v-if="revealed.has(rule.id)" :size="16" /><Eye
                  v-else
                  :size="16"
                /></button
              ><button
                class="icon-button delete-icon"
                :aria-label="`删除 ${rule.key}`"
                @click="
                  confirmDelete = confirmDelete === rule.id ? '' : rule.id
                "
              >
                <Trash2 :size="15" />
              </button>
            </div>
            <div v-if="confirmDelete === rule.id" class="delete-confirm">
              <span>删除这条规则？</span
              ><button
                class="text-button"
                :disabled="busy"
                @click="confirmDelete = ''"
              >
                取消</button
              ><button
                class="danger-button"
                :disabled="busy"
                @click="deleteRule(rule)"
              >
                删除
              </button>
            </div>
          </article>
        </div>
        <div v-else class="rule-list cookie-list">
          <div v-if="!context || !filteredCookies.length" class="empty-state">
            <span class="empty-symbol"><Cookie :size="26" /></span>
            <h3>
              {{
                !context
                  ? "先打开一个网站"
                  : query
                    ? "没有匹配的 Cookie"
                    : "这个网站没有 Cookie"
              }}
            </h3>
            <p>
              {{
                !context
                  ? "支持 HTTP 和 HTTPS 页面。"
                  : query
                    ? "试试其他名称或域名。"
                    : "可以手动写入需要的 Cookie。"
              }}
            </p>
          </div>
          <article
            v-for="cookie in filteredCookies"
            :key="siteCookieId(cookie)"
            class="rule-row site-cookie-row"
          >
            <span class="cookie-row-symbol"
              ><Cookie :size="18" :stroke-width="1.5"
            /></span>
            <button
              class="rule-content"
              :aria-label="`编辑 Cookie ${cookie.name}`"
              @click="openCookie(cookie)"
            >
              <span class="rule-name"
                >{{ cookie.name
                }}<LockKeyhole
                  v-if="cookie.httpOnly"
                  :size="12"
                  aria-label="HttpOnly" /></span
              ><span class="rule-value">{{
                revealed.has(siteCookieId(cookie))
                  ? cookie.value || "（空值）"
                  : "••••••••••••••••"
              }}</span
              ><span class="rule-scope"
                ><span :title="`${cookie.domain}${cookie.path}`"
                  >{{ cookie.domain }}{{ cookie.path }}</span
                ><span class="cookie-flag"
                  >{{ cookie.session ? "会话" : "持久"
                  }}{{ cookie.partitionKey ? " · 分区" : "" }}</span
                ></span
              >
            </button>
            <div class="row-actions">
              <button
                class="icon-button"
                :aria-label="`编辑网站 Cookie ${cookie.name}`"
                title="编辑 Cookie"
                @click="openCookie(cookie)"
              >
                <Pencil :size="15" /></button
              ><button
                class="icon-button"
                :aria-label="`${revealed.has(siteCookieId(cookie)) ? '隐藏' : '显示'} Cookie ${cookie.name} 的值`"
                @click="toggleReveal(siteCookieId(cookie))"
              >
                <EyeOff
                  v-if="revealed.has(siteCookieId(cookie))"
                  :size="16"
                /><Eye v-else :size="16" /></button
              ><button
                class="icon-button delete-icon"
                :aria-label="`删除 Cookie ${cookie.name}`"
                @click="
                  confirmDelete =
                    confirmDelete === siteCookieId(cookie)
                      ? ''
                      : siteCookieId(cookie)
                "
              >
                <Trash2 :size="15" />
              </button>
            </div>
            <div
              v-if="confirmDelete === siteCookieId(cookie)"
              class="delete-confirm"
            >
              <span>从浏览器删除？</span
              ><button
                class="text-button"
                :disabled="busy"
                @click="confirmDelete = ''"
              >
                取消</button
              ><button
                class="danger-button"
                :disabled="busy"
                @click="deleteCookie(cookie)"
              >
                删除
              </button>
            </div>
          </article>
        </div>
      </section>
      <footer class="app-footer">
        <span class="footer-status"
          ><span
            class="status-dot"
            :class="{ muted: !state.config.enabled || !!state.syncError }"
          />{{
            state.syncError
              ? "同步异常"
              : state.config.enabled
                ? `${enabledCount} 条注入规则已加载`
                : "请求注入已暂停"
          }}</span
        ><button
          class="text-button footer-sync"
          :disabled="busy || loading"
          @click="refresh"
        >
          <RefreshCw :size="13" />{{ tab === "site" ? "重新读取" : "重新同步" }}
        </button>
      </footer>
    </div>
    <Transition name="toast"
      ><div v-if="notice" class="toast" role="status">
        <Check :size="17" />{{ notice }}
      </div></Transition
    >
    <Transition name="editor">
      <section
        v-if="editor"
        class="editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
      >
        <header class="editor-header">
          <button
            class="icon-button"
            :disabled="busy"
            aria-label="返回列表"
            @click="closeEditor"
          >
            <ArrowLeft :size="19" />
          </button>
          <h2 id="editor-title">
            {{
              editor === "transfer"
                ? `${transferMode === "import" ? "批量导入" : "导出"}${transferTarget === "header" ? " Header" : transferTarget === "cookie" ? "请求 Cookie" : "网站 Cookie"}`
                : editor === "environments"
                  ? "管理环境"
                  : editor === "rule"
                    ? `${form.id ? "编辑" : "添加"}${form.kind === "header" ? " Header" : "请求 Cookie"}`
                    : `${cookieForm.original ? "编辑" : "写入"}网站 Cookie`
            }}
          </h2>
          <button
            class="icon-button"
            :disabled="busy"
            aria-label="关闭编辑"
            @click="closeEditor"
          >
            <X :size="18" />
          </button>
        </header>
        <TransferPanel
          v-if="editor === 'transfer'"
          :target="transferTarget"
          :mode="transferMode"
          :config="state.config"
          :context="context"
          :cookies="cookies"
          @state="state = $event"
          @cookies="cookies = $event"
          @busy="busy = $event"
          @done="transferDone"
        />
        <EnvironmentManager
          v-else-if="editor === 'environments'"
          :config="state.config"
          :busy="busy"
          :on-change="changeEnvironment"
        />
        <form
          v-else
          id="config-form"
          class="editor-body"
          @submit.prevent="save"
        >
          <template v-if="editor === 'rule'">
            <div class="field">
              <label for="rule-key">{{
                form.kind === "header" ? "Header 名称" : "请求头名称"
              }}</label
              ><input
                id="rule-key"
                v-model="form.key"
                :disabled="form.kind === 'cookie'"
                placeholder="如 X-Environment"
                autocomplete="off"
                required
              />
            </div>
            <div class="field">
              <label for="rule-value"
                >{{ form.kind === "header" ? "Header 值" : "Cookie 内容"
                }}<span v-if="form.kind === 'header'" class="optional"
                  >允许空值</span
                ></label
              ><textarea
                id="rule-value"
                v-model="form.value"
                :rows="form.kind === 'cookie' ? 4 : 3"
                :placeholder="
                  form.kind === 'cookie'
                    ? 'tenant=shanghai; debug_mode=1'
                    : '输入需要注入的值'
                "
                spellcheck="false"
              />
            </div>
            <div v-if="form.kind === 'cookie'" class="field">
              <label for="operation">注入方式</label
              ><UiSelect
                id="operation"
                :model-value="form.operation"
                label="注入方式"
                :disabled="busy"
                :options="[
                  { value: 'set', label: '替换整段 Cookie 头' },
                  { value: 'append', label: '追加到已有 Cookie 头' },
                ]"
                @update:model-value="
                  form.operation = $event as Rule['operation']
                "
              />
              <p class="field-help">
                {{
                  form.operation === "set"
                    ? "匹配请求原有的 Cookie 头将被完整替换。"
                    : "保留原内容并追加；同名 Cookie 不会自动去重。"
                }}
              </p>
            </div>
            <div class="field">
              <label for="rule-scope">生效范围</label
              ><UiSelect
                id="rule-scope"
                :model-value="form.scope"
                :options="scopeOptions"
                label="生效范围"
                :disabled="busy"
                @update:model-value="form.scope = $event as Rule['scope']"
              />
            </div>
            <div v-if="form.scope !== 'global'" class="field">
              <label for="rule-domain">{{
                form.scope === "regex" ? "域名正则" : "请求目标域名"
              }}</label
              ><input
                id="rule-domain"
                v-model="form.pattern"
                :placeholder="
                  form.scope === 'regex'
                    ? 'example\\.com'
                    : 'api.example.com 或 localhost:8080'
                "
                required
              /><label v-if="form.scope === 'domain'" class="checkbox-label"
                ><input
                  v-model="form.includeSubdomains"
                  type="checkbox"
                />包含子域名</label
              >
              <p class="field-help">
                {{
                  form.scope === "regex"
                    ? "从旧版迁移；切换为「指定网站」后可直接输入域名。"
                    : "按请求 URL 匹配，接口与页面域名不同时请填写接口域名。"
                }}
              </p>
            </div>
            <p v-if="form.scope === 'global'" class="info-box">
              <Info :size="16" />此配置作用于所有 HTTP / HTTPS
              网站，请确认值适合通用注入。
            </p>
            <label class="checkbox-label field-enable"
              ><input
                v-model="form.enabled"
                type="checkbox"
              />保存后启用这条规则</label
            >
          </template>
          <template v-else>
            <p class="editor-description">
              {{
                cookieForm.original
                  ? "修改后会立即更新浏览器中的这条 Cookie。"
                  : "写入当前网站；浏览器会按域名、Path 和 Cookie 属性决定发送范围。"
              }}
            </p>
            <div class="field">
              <label for="cookie-name">名称</label
              ><input
                id="cookie-name"
                v-model="cookieForm.name"
                :disabled="!!cookieForm.original"
                placeholder="session_id"
                required
                autocomplete="off"
              />
            </div>
            <div class="field">
              <label for="cookie-value"
                >值<span class="optional">允许空值</span></label
              ><textarea
                id="cookie-value"
                v-model="cookieForm.value"
                rows="3"
                spellcheck="false"
              />
            </div>
            <button
              class="advanced-toggle"
              type="button"
              :aria-expanded="advanced"
              @click="advanced = !advanced"
            >
              域名与 Cookie 属性<ChevronDown
                :size="16"
                :class="{ rotated: advanced }"
              />
            </button>
            <div v-show="advanced" class="advanced-fields">
              <div class="field">
                <label for="cookie-domain">Domain</label
                ><input
                  id="cookie-domain"
                  v-model="cookieForm.domain"
                  :disabled="!!cookieForm.original"
                  required
                /><label class="checkbox-label"
                  ><input
                    v-model="cookieForm.hostOnly"
                    type="checkbox"
                    :disabled="!!cookieForm.original"
                  />仅当前主机</label
                >
              </div>
              <div class="field">
                <label for="cookie-path">Path</label
                ><input
                  id="cookie-path"
                  v-model="cookieForm.path"
                  :disabled="!!cookieForm.original"
                  required
                />
              </div>
              <div class="checkbox-row">
                <label class="checkbox-label"
                  ><input
                    v-model="cookieForm.secure"
                    type="checkbox"
                  />Secure</label
                ><label class="checkbox-label"
                  ><input
                    v-model="cookieForm.httpOnly"
                    type="checkbox"
                  />HttpOnly</label
                >
              </div>
              <div class="field">
                <label for="same-site">SameSite</label
                ><UiSelect
                  id="same-site"
                  :model-value="cookieForm.sameSite"
                  label="SameSite"
                  :disabled="busy"
                  :options="[
                    { value: 'lax', label: 'Lax' },
                    { value: 'strict', label: 'Strict' },
                    { value: 'no_restriction', label: 'None（需要 Secure）' },
                    { value: 'unspecified', label: '未指定' },
                  ]"
                  @update:model-value="
                    cookieForm.sameSite = $event as CookieInput['sameSite']
                  "
                />
              </div>
              <div class="field">
                <label for="expiry"
                  >到期时间<span class="optional"
                    >留空为会话 Cookie</span
                  ></label
                ><input id="expiry" v-model="expiry" type="datetime-local" />
              </div>
              <p v-if="cookieForm.original?.partitionKey" class="field-help">
                保留原有的分区信息。
              </p>
            </div>
          </template>
          <p v-if="editorError" class="editor-error" role="alert">
            <Info :size="16" />{{ editorError }}
          </p>
        </form>
        <footer
          v-if="editor !== 'environments' && editor !== 'transfer'"
          class="editor-footer"
        >
          <button
            type="button"
            class="secondary-button"
            :disabled="busy"
            @click="closeEditor"
          >
            取消</button
          ><button
            class="primary-button save-button"
            type="submit"
            form="config-form"
            :disabled="busy"
          >
            <RefreshCw v-if="busy" class="spinning" :size="15" /><Check
              v-else
              :size="16"
            />{{
              busy ? "正在保存" : editor === "site" ? "写入 Cookie" : "保存规则"
            }}
          </button>
        </footer>
      </section>
    </Transition>
  </main>
</template>
