<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useId,
  watch,
} from "vue";
import {
  ChevronDown,
  Download,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-vue-next";
const props = defineProps<{
  site: boolean;
  disabled: boolean;
  addDisabled: boolean;
  importDisabled: boolean;
  exportDisabled: boolean;
  refreshDisabled: boolean;
}>();
const emit = defineEmits<{ add: []; import: []; export: []; refresh: [] }>();
const id = `actions-${useId()}`;
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const open = ref(false);
const menuDisabled = computed(
  () =>
    props.disabled ||
    (props.importDisabled && props.exportDisabled && props.refreshDisabled),
);
const position = ref({ top: "0px", left: "0px", maxHeight: "240px" });
let frame = 0;
function close(restore = false) {
  open.value = false;
  cancelAnimationFrame(frame);
  if (restore) trigger.value?.focus({ preventScroll: true });
}
function place() {
  if (!open.value || !trigger.value) return;
  const r = trigger.value.getBoundingClientRect();
  const height = menu.value?.offsetHeight || 152;
  const below = innerHeight - r.bottom - 12;
  const next = {
    top: `${below >= height ? r.bottom + 6 : Math.max(8, r.top - height - 6)}px`,
    left: `${Math.max(8, Math.min(r.right - 180, document.documentElement.clientWidth - 188))}px`,
    maxHeight: `${Math.max(48, innerHeight - 16)}px`,
  };
  if (
    Object.entries(next).some(
      ([key, value]) => position.value[key as keyof typeof next] !== value,
    )
  )
    position.value = next;
  frame = requestAnimationFrame(place);
}
function items() {
  return [
    ...(menu.value?.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ) || []),
  ];
}
async function show(last = false) {
  if (menuDisabled.value) return;
  document.dispatchEvent(
    new CustomEvent("request-helper:select-open", { detail: id }),
  );
  open.value = true;
  await nextTick();
  if (menuDisabled.value || !open.value) return;
  place();
  (last ? items().at(-1) : items()[0])?.focus({ preventScroll: true });
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "Tab") close(true);
  else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const buttons = items();
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[index]?.focus({ preventScroll: true });
  }
}
function choose(action: "import" | "export" | "refresh") {
  close(true);
  if (action === "import") emit("import");
  else if (action === "export") emit("export");
  else emit("refresh");
}
function outside(event: Event) {
  const target = event.target as Node;
  if (!trigger.value?.contains(target) && !menu.value?.contains(target))
    close();
}
function anotherOpened(event: Event) {
  if ((event as CustomEvent).detail !== id) close();
}
watch(menuDisabled, (value) => {
  if (value) close();
});
watch(
  () => props.site,
  () => close(),
);
onMounted(() => {
  document.addEventListener("pointerdown", outside);
  document.addEventListener("focusin", outside);
  document.addEventListener("request-helper:select-open", anotherOpened);
});
onUnmounted(() => {
  cancelAnimationFrame(frame);
  document.removeEventListener("pointerdown", outside);
  document.removeEventListener("focusin", outside);
  document.removeEventListener("request-helper:select-open", anotherOpened);
});
</script>
<template>
  <div class="rule-actions">
    <button
      class="primary-button compact add-button"
      :disabled="disabled || addDisabled"
      @click="emit('add')"
    >
      <Plus :size="15" />{{ site ? "写入 Cookie" : "添加规则" }}
    </button>
    <button
      ref="trigger"
      class="primary-button action-menu-trigger"
      aria-label="更多操作"
      title="导入、导出与重新应用"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? id : undefined"
      :disabled="menuDisabled"
      @click="open ? close() : show()"
      @keydown.down.prevent="show()"
      @keydown.up.prevent="show(true)"
    >
      <ChevronDown :size="15" :class="{ rotated: open }" />
    </button>
  </div>
  <Teleport to="body">
    <Transition name="action-menu">
      <div
        v-if="open"
        :id="id"
        ref="menu"
        class="action-menu"
        :style="position"
        role="menu"
        aria-label="更多操作"
        @keydown="keydown"
      >
        <button
          role="menuitem"
          tabindex="-1"
          class="import-button"
          :disabled="importDisabled"
          @click="choose('import')"
        >
          <Upload :size="15" />导入
        </button>
        <button
          role="menuitem"
          tabindex="-1"
          class="export-button"
          :disabled="exportDisabled"
          @click="choose('export')"
        >
          <Download :size="15" />导出
        </button>
        <div role="separator" class="action-menu-divider" />
        <button
          role="menuitem"
          tabindex="-1"
          class="reapply-button"
          :disabled="refreshDisabled"
          @click="choose('refresh')"
        >
          <RefreshCw :size="15" />{{
            site ? "重新读取 Cookie" : "重新应用规则"
          }}
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
