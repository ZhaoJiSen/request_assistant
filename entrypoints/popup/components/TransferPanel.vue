<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Info,
  RefreshCw,
} from "lucide-vue-next";
import UiSelect from "./UiSelect.vue";
import { request } from "../../../lib/client";
import {
  cookieSnapshot,
  exportCookies,
  exportRules,
  MAX_IMPORT_BYTES,
  planCookies,
  planRules,
  ruleSnapshot,
  type ImportOptions,
  type TransferTarget,
} from "../../../lib/transfer";
import type { CookieImportResult } from "../../../lib/cookie-transfer";
import type { Config, Context, State } from "../../../lib/types";
const props = defineProps<{
  target: TransferTarget;
  mode: "import" | "export";
  config: Config;
  context: Context | null;
  cookies: chrome.cookies.Cookie[];
}>();
const emit = defineEmits<{
  done: [message: string];
  state: [state: State];
  cookies: [cookies: chrome.cookies.Cookie[]];
  busy: [busy: boolean];
}>();
const text = ref("");
const error = ref("");
const failedItems = ref<{ name: string; error: string }[]>([]);
const feedback = ref("");
const preview = ref(false);
const expected = ref("");
const busy = ref(false);
const reveal = ref(false);
const copied = ref(false);
const fileInput = ref<HTMLInputElement>();
const options = ref<ImportOptions>({
  target: props.target,
  scope: props.context ? "domain" : "global",
  pattern: props.context?.host || "",
  conflict: "skip",
  operation: "set",
});
const environment = computed(
  () =>
    props.config.environments.find(
      (e) => e.id === props.config.activeEnvironmentId,
    )?.name,
);
const rows = computed(() => {
  if (!text.value.trim()) return [];
  try {
    return props.target === "site"
      ? planCookies(
          props.cookies,
          text.value,
          props.context!,
          options.value.conflict,
        )
      : planRules(props.config, text.value, options.value);
  } catch {
    return [];
  }
});
const summary = computed(() => ({
  add: rows.value.filter((r) => r.action === "add").length,
  replace: rows.value.filter((r) => r.action === "replace").length,
  skip: rows.value.filter((r) => r.action === "skip").length,
}));
const output = computed(() =>
  props.target === "site"
    ? exportCookies(props.cookies)
    : exportRules(props.config, props.target),
);
const exportCount = computed(() =>
  props.target === "site"
    ? props.cookies.length
    : props.config.rules.filter(
        (r) =>
          r.environmentId === props.config.activeEnvironmentId &&
          r.kind === props.target,
      ).length,
);
const placeholder = computed(() =>
  props.target === "header"
    ? "Authorization: Bearer your-token\nX-Environment: staging"
    : "session_id=your-value; tenant=shanghai",
);
watch(
  [text, options],
  () => {
    preview.value = false;
    error.value = "";
    failedItems.value = [];
  },
  { deep: true },
);
watch([error, failedItems], async ([value, failures]) => {
  if (value || failures.length) {
    await nextTick();
    document
      .querySelector(".transfer-body .editor-error")
      ?.scrollIntoView({ block: "nearest" });
  }
});
function inspect() {
  error.value = "";
  feedback.value = "";
  failedItems.value = [];
  try {
    if (props.target === "site")
      planCookies(
        props.cookies,
        text.value,
        props.context!,
        options.value.conflict,
      );
    else planRules(props.config, text.value, options.value);
    expected.value =
      props.target === "site"
        ? cookieSnapshot(props.cookies)
        : ruleSnapshot(props.config);
    preview.value = true;
    void nextTick(() =>
      document.querySelector<HTMLElement>(".import-preview")?.focus(),
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : "解析失败";
  }
}
async function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error("文件不能超过 1 MB");
    text.value = await file.text();
    feedback.value = `已读取 ${file.name}`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "无法读取文件";
  } finally {
    input.value = "";
  }
}
async function submit() {
  if (busy.value) return;
  busy.value = true;
  emit("busy", true);
  error.value = "";
  const payload = {
    ...options.value,
    text: text.value,
    environmentId: props.config.activeEnvironmentId,
    url: props.context?.url,
    expected: expected.value,
  };
  try {
    if (props.target === "site") {
      const result = await request<CookieImportResult>(
        "IMPORT_COOKIES",
        payload,
      );
      emit("cookies", result.cookies);
      if (result.failed.length) {
        text.value = JSON.stringify(
          result.failed.map((r) => r.input),
          null,
          2,
        );
        await nextTick();
        feedback.value = `已写入 ${result.imported} 条，跳过 ${result.skipped} 条；剩余 ${result.failed.length} 条未完成。`;
        failedItems.value = result.failed.map(({ name, error }) => ({
          name,
          error,
        }));
      } else
        emit(
          "done",
          `已写入 ${result.imported} 条 Cookie，跳过 ${result.skipped} 条`,
        );
    } else {
      const count = summary.value.add + summary.value.replace,
        skip = summary.value.skip;
      emit("state", await request<State>("IMPORT_RULES", payload));
      emit("done", `已导入 ${count} 条规则，跳过 ${skip} 条`);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "导入失败，内容已保留";
  } finally {
    busy.value = false;
    emit("busy", false);
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(output.value);
    copied.value = true;
    error.value = "";
  } catch {
    error.value = "无法访问剪贴板，请下载 JSON 文件";
  }
}
function download() {
  const url = URL.createObjectURL(
    new Blob([output.value], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `request-helper-${props.target}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  feedback.value = "已发起 JSON 文件下载";
}
</script>
<template>
  <div class="transfer-panel">
    <div class="editor-body transfer-body">
      <p class="transfer-destination">
        <span>{{ target === "site" ? "当前网站" : "当前环境" }}</span
        ><strong>{{ target === "site" ? context?.host : environment }}</strong>
      </p>
      <template v-if="mode === 'import'">
        <template v-if="!preview">
          <div class="field transfer-source">
            <label for="import-text"
              >{{ target === "header" ? "粘贴 Header" : "粘贴 Cookie"
              }}<button
                type="button"
                class="text-button"
                :disabled="busy"
                @click="fileInput?.click()"
              >
                <FileUp :size="14" />选择文件
              </button></label
            >
            <input
              ref="fileInput"
              class="visually-hidden"
              type="file"
              accept=".json,.txt,application/json,text/plain"
              aria-label="选择导入文件"
              :disabled="busy"
              @change="chooseFile"
            />
            <textarea
              id="import-text"
              v-model="text"
              :placeholder="placeholder"
              :disabled="busy"
              spellcheck="false"
              rows="5"
            />
            <p class="field-help">
              {{
                target === "header"
                  ? "每行一个 名称: 值，也支持 JSON 对象或规则文件。"
                  : target === "cookie"
                    ? "支持 Cookie 请求头或规则文件，仅修改请求。"
                    : "支持 Cookie 字符串或 JSON。字符串覆盖时保留已有属性；新建默认当前主机、Path=/。"
              }}
            </p>
          </div>
          <template v-if="target !== 'site'">
            <div class="transfer-two-fields">
              <div class="field">
                <label for="import-scope">文本生效范围</label
                ><UiSelect
                  id="import-scope"
                  v-model="options.scope"
                  label="文本生效范围"
                  :disabled="busy"
                  :options="[
                    { value: 'domain', label: '指定网站' },
                    { value: 'global', label: '所有网站' },
                  ]"
                />
              </div>
              <div v-if="options.scope === 'domain'" class="field">
                <label for="import-domain">目标域名</label
                ><input
                  id="import-domain"
                  v-model="options.pattern"
                  :disabled="busy"
                  placeholder="api.example.com"
                />
              </div>
            </div>
            <div v-if="target === 'cookie'" class="field">
              <label for="import-operation">文本注入方式</label
              ><UiSelect
                id="import-operation"
                v-model="options.operation"
                label="文本注入方式"
                :disabled="busy"
                :options="[
                  { value: 'set', label: '替换整段 Cookie 头' },
                  { value: 'append', label: '追加到已有 Cookie 头' },
                ]"
              />
            </div>
          </template>
          <div class="field">
            <label for="import-conflict">已存在的项目</label
            ><UiSelect
              id="import-conflict"
              v-model="options.conflict"
              label="已存在的项目"
              :disabled="busy"
              :options="[
                { value: 'skip', label: '跳过，保留现有值' },
                { value: 'replace', label: '覆盖为导入的值' },
              ]"
            />
            <p class="field-help">
              {{
                target === "site"
                  ? "名称、Domain、Path 和分区相同视为同一项。"
                  : "名称与生效范围相同视为同一项；只影响当前环境。"
              }}
            </p>
          </div>
        </template>
        <section
          v-else
          class="import-preview"
          tabindex="-1"
          aria-label="导入预览"
        >
          <div class="transfer-summary">
            <strong>{{ rows.length }} 条待处理</strong
            ><button
              type="button"
              class="text-button"
              :disabled="busy"
              @click="preview = false"
            >
              返回修改
            </button>
          </div>
          <div class="transfer-preview-tools">
            <p class="transfer-counts">
              新增 {{ summary.add }}<span>覆盖 {{ summary.replace }}</span
              ><span>跳过 {{ summary.skip }}</span>
            </p>
            <button
              type="button"
              class="text-button preview-reveal"
              :aria-pressed="reveal"
              @click="reveal = !reveal"
            >
              <EyeOff v-if="reveal" :size="14" /><Eye v-else :size="14" />{{
                reveal ? "隐藏值" : "显示值"
              }}
            </button>
          </div>
          <p class="field-help">
            {{
              target === "site"
                ? "确认后写入浏览器 Cookie。浏览器可能拒绝部分项目，结果会逐项保留。"
                : "保存到当前环境，保留文件内的生效范围。"
            }}
          </p>
          <div class="transfer-list">
            <article
              v-for="(row, index) in rows"
              :key="index"
              class="transfer-row"
            >
              <div>
                <strong>{{
                  "key" in row.item ? row.item.key : row.item.name
                }}</strong
                ><span>{{
                  "pattern" in row.item
                    ? row.item.scope === "global"
                      ? "所有网站"
                      : `${row.item.scope === "regex" ? "正则 · " : ""}${row.item.pattern}${row.item.scope === "domain" && row.item.includeSubdomains ? " 及子域" : ""}`
                    : `${row.item.domain} · ${row.item.path}`
                }}</span>
                <span
                  class="transfer-value"
                  :title="reveal ? row.item.value : undefined"
                  >{{
                    !row.item.value
                      ? "（空值）"
                      : reveal ||
                          (target === "header" &&
                            "key" in row.item &&
                            !/authorization|token|secret|password|api[-_]?key/i.test(
                              row.item.key,
                            ))
                        ? row.item.value
                        : "••••••••"
                  }}</span
                >
                <span
                  v-if="'httpOnly' in row.item"
                  class="transfer-cookie-flags"
                  >{{
                    [
                      row.item.hostOnly ? "仅当前主机" : "包含子域",
                      row.item.httpOnly ? "HttpOnly" : "",
                      row.item.secure ? "Secure" : "",
                      row.item.expirationDate ? "持久" : "会话",
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  }}</span
                >
                <span v-else-if="row.item.kind === 'cookie'">{{
                  row.item.operation === "append"
                    ? "追加到已有 Cookie 头"
                    : "替换整段 Cookie 头"
                }}</span>
              </div>
              <span class="transfer-action" :class="row.action">{{
                row.action === "add"
                  ? "新增"
                  : row.action === "replace"
                    ? "覆盖"
                    : "跳过"
              }}</span>
            </article>
          </div>
        </section>
      </template>
      <template v-else>
        <div class="transfer-export-title">
          <strong
            >导出 {{ exportCount }} 条{{
              target === "site" ? " Cookie" : "规则"
            }}</strong
          ><button
            type="button"
            class="text-button"
            :aria-pressed="reveal"
            @click="reveal = !reveal"
          >
            <EyeOff v-if="reveal" :size="15" /><Eye v-else :size="15" />{{
              reveal ? "隐藏内容" : "显示内容"
            }}
          </button>
        </div>
        <p class="field-help">
          {{
            target === "site"
              ? "导出当前网站的全部 Cookie，保留属性，可再次导入。"
              : "导出当前环境、当前标签页的全部规则，包含已停用项。"
          }}文件包含完整值，请妥善保管。
        </p>
        <textarea
          v-if="reveal"
          class="export-code"
          :value="output"
          readonly
          aria-label="导出 JSON 内容"
          spellcheck="false"
        />
        <div v-else class="export-hidden">
          <Download :size="28" /><strong>JSON 文件已准备好</strong>
        </div>
      </template>
      <p v-if="feedback" class="transfer-feedback" role="status">
        {{ feedback }}
      </p>
      <div v-if="failedItems.length" class="editor-error" role="alert">
        <Info :size="16" />
        <ul class="transfer-failures">
          <li v-for="failure in failedItems" :key="failure.name">
            <strong>{{ failure.name }}</strong
            ><span>{{ failure.error }}</span>
          </li>
        </ul>
      </div>
      <p v-if="error" class="editor-error" role="alert">
        <Info :size="16" /><span>{{ error }}</span>
      </p>
    </div>
    <footer class="editor-footer transfer-footer">
      <template v-if="mode === 'import'"
        ><span v-if="!preview" class="transfer-limit">最多 500 条 · 1 MB</span
        ><button
          class="primary-button import-submit"
          :disabled="
            busy ||
            !text.trim() ||
            (preview && !summary.add && !summary.replace)
          "
          @click="preview ? submit() : inspect()"
        >
          <RefreshCw v-if="busy" class="spinning" :size="15" /><Check
            v-else
            :size="16"
          />{{
            busy
              ? "正在导入"
              : preview
                ? `确认导入 ${summary.add + summary.replace} 条`
                : "解析并预览"
          }}
        </button></template
      >
      <template v-else
        ><button
          class="secondary-button export-copy"
          :disabled="!exportCount"
          @click="copy"
        >
          <Check v-if="copied" :size="15" /><Copy v-else :size="15" />{{
            copied ? "已复制 JSON" : "复制 JSON"
          }}</button
        ><button
          class="primary-button export-download"
          :disabled="!exportCount"
          @click="download"
        >
          <Download :size="16" />下载 JSON
        </button></template
      >
    </footer>
  </div>
</template>
