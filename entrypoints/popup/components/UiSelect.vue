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
import { Check, ChevronDown, Plus, Search } from "lucide-vue-next";
export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  descriptionPlaceholder?: boolean;
  disabled?: boolean;
}
const props = defineProps<{
  modelValue: string;
  options: SelectOption[];
  label: string;
  id?: string;
  disabled?: boolean;
  searchable?: boolean;
  columns?: { label: string; description: string };
  addLabel?: string;
  addDisabled?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  add: [];
}>();
const unique = useId();
const listId = `select-${unique}`;
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const optionsElement = ref<HTMLElement>();
const searchInput = ref<HTMLInputElement>();
const open = ref(false);
const active = ref(-1);
const query = ref("");
const visibleOptions = computed(() => {
  const text = query.value.trim().toLowerCase();
  return props.options.filter(
    (o) =>
      !text || `${o.label} ${o.description || ""}`.toLowerCase().includes(text),
  );
});
const position = ref({
  top: "0px",
  left: "0px",
  width: "0px",
  maxHeight: "240px",
});
const selected = computed(() =>
  props.options.find((o) => o.value === props.modelValue),
);
const activeId = computed(() =>
  open.value && active.value >= 0 ? `${listId}-${active.value}` : undefined,
);
let placementFrame = 0;
let search = "",
  searchTimer: ReturnType<typeof setTimeout>;
function close(restore = false) {
  cancelAnimationFrame(placementFrame);
  open.value = false;
  if (restore) trigger.value?.focus({ preventScroll: true });
}
function followAnimatedTrigger() {
  if (!open.value) return;
  place();
  placementFrame = requestAnimationFrame(followAnimatedTrigger);
}
function place() {
  if (!open.value || !trigger.value) return;
  const r = trigger.value.getBoundingClientRect();
  const viewportWidth = Math.min(
    innerWidth,
    document.documentElement.clientWidth,
  );
  const width = Math.min(
    Math.max(r.width, props.searchable ? 248 : 168),
    viewportWidth - 16,
  );
  const chrome =
    menu.value && optionsElement.value
      ? menu.value.offsetHeight - optionsElement.value.clientHeight
      : 10;
  const desired = Math.min(
    (optionsElement.value?.scrollHeight ?? 228) + chrome,
    props.searchable ? 336 : 280,
  );
  const below = innerHeight - r.bottom - 14,
    above = r.top - 14;
  const down = below >= desired || below >= above;
  const height = Math.max(48, Math.min(desired, down ? below : above));
  const next = {
    top: `${down ? r.bottom + 6 : Math.max(8, r.top - height - 6)}px`,
    left: `${Math.max(8, Math.min(r.left, viewportWidth - width - 8))}px`,
    width: `${width}px`,
    maxHeight: `${height}px`,
  };
  if (
    Object.entries(next).some(
      ([key, value]) => position.value[key as keyof typeof next] !== value,
    )
  )
    position.value = next;
}
function resetActive() {
  active.value = visibleOptions.value.findIndex(
    (o) => o.value === props.modelValue && !o.disabled,
  );
  if (active.value < 0)
    active.value = visibleOptions.value.findIndex((o) => !o.disabled);
  scrollActive();
}
async function show(initialQuery = "") {
  if (props.disabled) return;
  document.dispatchEvent(
    new CustomEvent("request-helper:select-open", { detail: listId }),
  );
  query.value = initialQuery;
  resetActive();
  open.value = true;
  await nextTick();
  place();
  placementFrame = requestAnimationFrame(followAnimatedTrigger);
  scrollActive();
  if (props.searchable) searchInput.value?.focus({ preventScroll: true });
}
function scrollActive() {
  void nextTick(() =>
    document
      .getElementById(`${listId}-${active.value}`)
      ?.scrollIntoView({ block: "nearest" }),
  );
}
function choose(index: number) {
  const option = visibleOptions.value[index];
  if (!option || option.disabled || props.disabled) return;
  close(true);
  if (option.value !== props.modelValue)
    emit("update:modelValue", option.value);
}
function add() {
  if (props.disabled || props.addDisabled) return;
  close(true);
  emit("add");
}
function move(direction: number) {
  const count = visibleOptions.value.length;
  for (let step = 1; step <= count; step++) {
    const i = (active.value + direction * step + count * 2) % count;
    if (!visibleOptions.value[i]?.disabled) {
      active.value = i;
      scrollActive();
      return;
    }
  }
}
function keydown(event: KeyboardEvent) {
  if (props.disabled) return;
  const inSearch = event.target === searchInput.value;
  const inFooter = (event.target as HTMLElement).closest(".select-menu-footer");
  if (event.key === "Tab") {
    // The search field and footer action form a single keyboard sequence.
    if (inSearch && props.addLabel && !props.addDisabled && !event.shiftKey)
      return;
    if (inFooter && props.searchable && event.shiftKey) return;
    close(true);
    return;
  }
  if (event.key === "Escape" && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
  if (inFooter) return;
  if (inSearch && ["Home", "End", " "].includes(event.key)) return;
  if (
    ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (!open.value) {
      void show();
      return;
    }
    if (event.key === "Enter" || event.key === " ") choose(active.value);
    else if (event.key === "Home" || event.key === "End") {
      const indices = visibleOptions.value
        .map((_, i) => i)
        .filter((i) => !visibleOptions.value[i]!.disabled);
      active.value = (event.key === "Home" ? indices[0] : indices.at(-1)) ?? -1;
      scrollActive();
    } else move(event.key === "ArrowDown" ? 1 : -1);
  } else if (
    !inSearch &&
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    if (props.searchable) {
      event.preventDefault();
      void show(event.key);
      return;
    }
    search += event.key.toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      search = "";
    }, 600);
    const index = visibleOptions.value.findIndex(
      (o) => !o.disabled && o.label.toLowerCase().startsWith(search),
    );
    if (index >= 0) {
      if (open.value) {
        active.value = index;
        scrollActive();
      } else choose(index);
    }
  }
}
function outside(event: PointerEvent | FocusEvent) {
  const target = event.target as Node;
  if (!trigger.value?.contains(target) && !menu.value?.contains(target))
    close();
}
function anotherOpened(event: Event) {
  if ((event as CustomEvent).detail !== listId) close();
}
watch([query, visibleOptions], ([text, options], [previousText, previous]) => {
  if (text !== previousText) {
    resetActive();
    return;
  }
  // Parent status/toast updates can recreate the options array. Keep the
  // keyboard highlight on the same value instead of resetting navigation.
  const current = previous[active.value];
  const index = current
    ? options.findIndex(
        (option) => option.value === current.value && !option.disabled,
      )
    : -1;
  if (index >= 0) active.value = index;
  else resetActive();
});
watch(
  () => props.disabled,
  (value) => {
    if (value) close();
  },
);
onMounted(() => {
  document.addEventListener("pointerdown", outside);
  document.addEventListener("focusin", outside);
  document.addEventListener("request-helper:select-open", anotherOpened);
  document.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
});
onUnmounted(() => {
  cancelAnimationFrame(placementFrame);
  clearTimeout(searchTimer);
  document.removeEventListener("pointerdown", outside);
  document.removeEventListener("focusin", outside);
  document.removeEventListener("request-helper:select-open", anotherOpened);
  document.removeEventListener("scroll", place, true);
  window.removeEventListener("resize", place);
});
</script>

<template>
  <div class="ui-select">
    <button
      :id="id"
      ref="trigger"
      type="button"
      class="select-trigger"
      role="combobox"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="searchable ? undefined : activeId"
      :title="
        [selected?.label, selected?.description].filter(Boolean).join(' · ')
      "
      :disabled="disabled"
      :class="{ 'is-open': open }"
      @click="open ? close() : show()"
      @keydown="keydown"
    >
      <slot name="leading" />
      <span class="select-value"
        ><span>{{ selected?.label || "请选择" }}</span
        ><span
          v-if="selected?.description"
          class="select-value-description"
          :class="{ 'is-placeholder': selected.descriptionPlaceholder }"
          >{{ selected.description }}</span
        ></span
      >
      <ChevronDown
        :size="15"
        :class="{ rotated: open }"
        class="select-chevron"
      />
    </button>
    <Teleport to="body">
      <Transition name="select-menu">
        <div
          v-if="open"
          ref="menu"
          class="select-popover"
          :class="{
            'select-searchable': searchable,
            'select-with-columns': !!columns,
          }"
          :style="position"
          @keydown="keydown"
        >
          <div v-if="searchable" class="select-search">
            <Search :size="15" /><input
              ref="searchInput"
              v-model="query"
              role="combobox"
              :aria-label="`${label}，搜索值或别名`"
              aria-autocomplete="list"
              :aria-expanded="open"
              :aria-controls="listId"
              :aria-activedescendant="activeId"
              placeholder="搜索值或别名"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div v-if="columns" class="select-column-labels" aria-hidden="true">
            <span>{{ columns.label }}</span
            ><span>{{ columns.description }}</span
            ><span />
          </div>
          <div
            :id="listId"
            ref="optionsElement"
            role="listbox"
            :aria-label="label"
            class="select-options"
          >
            <div
              v-for="(option, index) in visibleOptions"
              :id="`${listId}-${index}`"
              :key="option.value"
              role="option"
              :aria-selected="option.value === modelValue"
              :aria-disabled="!!option.disabled"
              :title="
                [option.label, option.description].filter(Boolean).join(' · ')
              "
              class="select-option"
              :class="{
                active: active === index,
                selected: option.value === modelValue,
                unavailable: option.disabled,
              }"
              @pointermove="!option.disabled && (active = index)"
              @pointerdown.prevent
              @click="choose(index)"
            >
              <span class="select-option-content"
                ><span class="select-option-label">{{ option.label }}</span
                ><span
                  v-if="option.description"
                  class="select-option-description"
                  :class="{ 'is-placeholder': option.descriptionPlaceholder }"
                  >{{ option.description }}</span
                ></span
              ><Check v-if="option.value === modelValue" :size="15" />
            </div>
            <p v-if="!visibleOptions.length" class="select-empty" role="status">
              没有匹配的值
            </p>
          </div>
          <div v-if="addLabel" class="select-menu-footer">
            <button
              type="button"
              class="select-add"
              :disabled="addDisabled || disabled"
              @click="add"
            >
              <Plus :size="15" />{{
                addDisabled ? "已达 30 个候选值" : addLabel
              }}
            </button>
          </div>
          <div v-if="$slots.footer" class="select-menu-footer" @click="close()">
            <slot name="footer" />
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
