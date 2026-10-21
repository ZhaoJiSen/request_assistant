<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Check, Copy, Info, Pencil, Plus, Trash2 } from "lucide-vue-next";
import type { Config, EnvironmentCommand } from "../../../lib/types";
const props = defineProps<{
  config: Config;
  busy: boolean;
  onChange: (command: EnvironmentCommand) => Promise<void>;
}>();
const editing = ref<{
  action: "create" | "rename" | "duplicate";
  id: string;
} | null>(null);
const name = ref("");
const error = ref("");
const deleting = ref("");
const nameInput = ref<HTMLInputElement>();
const title = computed(() =>
  editing.value?.action === "rename"
    ? "重命名环境"
    : editing.value?.action === "duplicate"
      ? "复制环境"
      : "新建环境",
);
function count(id: string) {
  return props.config.rules.filter((r) => r.environmentId === id).length;
}
async function start(action: "create" | "rename" | "duplicate", id = "") {
  const source = props.config.environments.find((e) => e.id === id);
  editing.value = { action, id };
  deleting.value = "";
  error.value = "";
  name.value = action === "rename" ? source!.name : "";
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
}
async function execute(command: EnvironmentCommand) {
  if (props.busy) return;
  error.value = "";
  try {
    await props.onChange(command);
    editing.value = null;
    deleting.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "操作失败，请重试";
  }
}
async function submit() {
  if (!editing.value || props.busy) return;
  if (!name.value.trim()) {
    error.value = "请输入环境名称";
    nameInput.value?.focus();
    return;
  }
  const command =
    editing.value.action === "create"
      ? { action: "create" as const, name: name.value }
      : { ...editing.value, name: name.value };
  await execute(command);
}
function cancel() {
  editing.value = null;
  error.value = "";
}
</script>

<template>
  <div class="environment-manager editor-body">
    <p class="editor-description">
      每个环境独立保存 Header 和请求 Cookie 规则。网站 Cookie 由浏览器单独管理。
    </p>
    <div class="environment-list" aria-label="环境列表">
      <article
        v-for="environment in config.environments"
        :key="environment.id"
        class="environment-row"
        :class="{ current: environment.id === config.activeEnvironmentId }"
      >
        <button
          type="button"
          class="environment-choice"
          :aria-label="`切换到环境 ${environment.name}`"
          :aria-pressed="environment.id === config.activeEnvironmentId"
          :disabled="busy || !!editing"
          @click="execute({ action: 'switch', id: environment.id })"
        >
          <span class="environment-radio"
            ><Check
              v-if="environment.id === config.activeEnvironmentId"
              :size="12"
          /></span>
          <span class="environment-details"
            ><strong :title="environment.name">{{ environment.name }}</strong>
            <span
              >{{ count(environment.id) }} 条规则<span
                v-if="environment.id === config.activeEnvironmentId"
              >
                · 当前使用</span
              ></span
            ></span
          >
        </button>
        <div class="environment-actions">
          <button
            type="button"
            class="icon-button"
            :disabled="busy"
            :aria-label="`重命名环境 ${environment.name}`"
            title="重命名"
            @click="start('rename', environment.id)"
          >
            <Pencil :size="15" />
          </button>
          <button
            type="button"
            class="icon-button"
            :disabled="busy || config.environments.length >= 30"
            :aria-label="`复制环境 ${environment.name}`"
            title="复制环境"
            @click="start('duplicate', environment.id)"
          >
            <Copy :size="15" />
          </button>
          <button
            type="button"
            class="icon-button delete-icon"
            :disabled="busy || config.environments.length === 1"
            :aria-label="`删除环境 ${environment.name}`"
            title="删除环境"
            @click="
              deleting = environment.id;
              editing = null;
              error = '';
            "
          >
            <Trash2 :size="15" />
          </button>
        </div>
        <div v-if="deleting === environment.id" class="environment-delete">
          <p>
            删除「{{ environment.name }}」及其中的
            {{ count(environment.id) }} 条规则？
          </p>
          <p
            v-if="environment.id === config.activeEnvironmentId"
            class="field-help"
          >
            删除后切换到「{{
              config.environments.find((e) => e.id !== environment.id)?.name
            }}」。
          </p>
          <div>
            <button
              type="button"
              class="secondary-button compact"
              :disabled="busy"
              @click="deleting = ''"
            >
              取消
            </button>
            <button
              type="button"
              class="danger-button"
              :disabled="busy"
              @click="execute({ action: 'delete', id: environment.id })"
            >
              删除环境
            </button>
          </div>
        </div>
      </article>
    </div>
    <button
      v-if="!editing"
      type="button"
      class="secondary-button new-environment"
      :disabled="busy || config.environments.length >= 30"
      @click="start('create')"
    >
      <Plus :size="16" />新建环境
    </button>
    <form v-else class="environment-form" @submit.prevent="submit">
      <h3>{{ title }}</h3>
      <p v-if="editing.action === 'duplicate'" class="field-help">
        复制「{{
          config.environments.find((e) => e.id === editing!.id)?.name
        }}」的规则，创建后立即切换。
      </p>
      <p v-else-if="editing.action === 'create'" class="field-help">
        从空白规则开始，创建后立即切换。
      </p>
      <div class="field">
        <label for="environment-name">环境名称</label>
        <input
          id="environment-name"
          ref="nameInput"
          v-model="name"
          maxlength="24"
          :disabled="busy"
          placeholder="如 测试环境"
          autocomplete="off"
          required
        />
      </div>
      <p v-if="error" class="editor-error" role="alert">
        <Info :size="16" />{{ error }}
      </p>
      <div class="environment-form-actions">
        <button
          type="button"
          class="secondary-button"
          :disabled="busy"
          @click="cancel"
        >
          取消
        </button>
        <button
          type="submit"
          class="primary-button environment-save"
          :disabled="busy"
        >
          {{
            busy
              ? "正在保存"
              : editing.action === "rename"
                ? "保存名称"
                : "创建并切换"
          }}
        </button>
      </div>
    </form>
    <p v-if="error && !editing" class="editor-error" role="alert">
      <Info :size="16" />{{ error }}
    </p>
    <p class="environment-limit">
      {{ config.environments.length }} / 30 个环境
    </p>
  </div>
</template>
