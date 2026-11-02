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
  Check,
  ChevronDown,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-vue-next";
export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  descriptionPlaceholder?: boolean;
  disabled?: boolean;
}
export interface SelectOptionAdd {
  value: string;
  alias: string;
}
export interface SelectOptionEdit {
  value: string;
  field: "value" | "alias";
  text: string;
  previousAlias: string;
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
  addOption?: (value: SelectOptionAdd) => Promise<void>;
  saveOption?: (edit: SelectOptionEdit) => Promise<void>;
  valueEditDisabled?: boolean;
  removeOption?: (value: string) => Promise<void>;
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
const editInput = ref<HTMLInputElement>();
const editing = ref<{
  option: SelectOption;
  field: "value" | "alias";
  text: string;
  error: string;
} | null>(null);
const saving = ref(false);
const adding = ref<{ value: string; alias: string; error: string } | null>(
  null,
);
const addInput = ref<HTMLInputElement>();
const removing = ref<{ option: SelectOption; error: string } | null>(null);
const removeConfirm = ref<HTMLButtonElement>();
const visibleOptions = computed(() => {
  const text = query.value.trim().toLowerCase();
  return props.options.filter(
    (o) =>
      o.value === editing.value?.option.value ||
      !text ||
      `${o.label} ${o.description || ""}`.toLowerCase().includes(text),
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
  if (saving.value) return;
  cancelAnimationFrame(placementFrame);
  open.value = false;
  editing.value = null;
  adding.value = null;
  removing.value = null;
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
  if (
    !option ||
    option.disabled ||
    props.disabled ||
    editing.value ||
    adding.value ||
    removing.value ||
    saving.value
  )
    return;
  close(true);
  if (option.value !== props.modelValue)
    emit("update:modelValue", option.value);
}
async function add() {
  if (
    props.disabled ||
    props.addDisabled ||
    editing.value ||
    adding.value ||
    removing.value ||
    saving.value
  )
    return;
  if (!props.addOption) {
    close(true);
    emit("add");
    return;
  }
  adding.value = { value: "", alias: "", error: "" };
  await nextTick();
  place();
  addInput.value?.focus({ preventScroll: true });
}
function cancelAdd() {
  if (saving.value) return;
  adding.value = null;
  void nextTick(() =>
    menu.value
      ?.querySelector<HTMLButtonElement>(".select-add")
      ?.focus({ preventScroll: true }),
  );
}
async function saveAdd() {
  const draft = adding.value;
  if (!draft || !props.addOption || saving.value) return;
  draft.error = "";
  saving.value = true;
  try {
    await props.addOption({ value: draft.value, alias: draft.alias });
    adding.value = null;
    query.value = "";
    saving.value = false;
    await nextTick();
    resetActive();
    searchInput.value?.focus({ preventScroll: true });
  } catch (error) {
    draft.error = error instanceof Error ? error.message : "添加失败，请重试";
    saving.value = false;
    await nextTick();
    addInput.value?.focus({ preventScroll: true });
  } finally {
    saving.value = false;
  }
}
function addKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancelAdd();
  } else if (
    event.key === "Enter" &&
    event.target instanceof HTMLInputElement
  ) {
    event.preventDefault();
    void saveAdd();
  }
}
async function startRemove(option: SelectOption) {
  if (
    !props.removeOption ||
    props.options.length <= 1 ||
    removing.value ||
    props.disabled ||
    editing.value ||
    adding.value ||
    saving.value
  )
    return;
  removing.value = { option: { ...option }, error: "" };
  active.value = visibleOptions.value.findIndex(
    (o) => o.value === option.value,
  );
  await nextTick();
  place();
  scrollActive();
  removeConfirm.value?.focus({ preventScroll: true });
}
function cancelRemove() {
  if (saving.value) return;
  const value = removing.value?.option.value;
  removing.value = null;
  void nextTick(() => {
    const index = visibleOptions.value.findIndex((o) => o.value === value);
    document
      .getElementById(`${listId}-${index}`)
      ?.querySelector<HTMLButtonElement>(".select-delete")
      ?.focus({ preventScroll: true });
  });
}
async function saveRemove() {
  const draft = removing.value;
  if (!draft || !props.removeOption || saving.value) return;
  saving.value = true;
  draft.error = "";
  try {
    await props.removeOption(draft.option.value);
    removing.value = null;
    saving.value = false;
    await nextTick();
    resetActive();
    searchInput.value?.focus({ preventScroll: true });
  } catch (error) {
    draft.error = error instanceof Error ? error.message : "删除失败，请重试";
    saving.value = false;
    await nextTick();
    removeConfirm.value?.focus({ preventScroll: true });
  } finally {
    saving.value = false;
  }
}
async function startEdit(option: SelectOption, field: "value" | "alias") {
  if (
    !props.saveOption ||
    removing.value ||
    adding.value ||
    props.disabled ||
    saving.value ||
    (field === "value" && props.valueEditDisabled)
  )
    return;
  editing.value = {
    option: { ...option },
    field,
    text:
      field === "value"
        ? option.value
        : option.descriptionPlaceholder
          ? ""
          : option.description || "",
    error: "",
  };
  active.value = visibleOptions.value.findIndex(
    (o) => o.value === option.value,
  );
  await nextTick();
  editInput.value?.focus({ preventScroll: true });
  editInput.value?.select();
  editInput.value?.scrollIntoView({ block: "nearest" });
}
function setEditInput(element: unknown) {
  editInput.value = element instanceof HTMLInputElement ? element : undefined;
}
function cancelEdit() {
  if (saving.value) return;
  editing.value = null;
  void nextTick(() => searchInput.value?.focus({ preventScroll: true }));
}
async function saveEdit() {
  const edit = editing.value;
  if (!edit || !props.saveOption || saving.value) return;
  edit.error = "";
  saving.value = true;
  try {
    await props.saveOption({
      value: edit.option.value,
      field: edit.field,
      text: edit.text,
      previousAlias: edit.option.descriptionPlaceholder
        ? ""
        : edit.option.description || "",
    });
    editing.value = null;
    saving.value = false;
    await nextTick();
    active.value = visibleOptions.value.findIndex(
      (o) =>
        o.value === (edit.field === "value" ? edit.text : edit.option.value),
    );
    searchInput.value?.focus({ preventScroll: true });
  } catch (error) {
    edit.error = error instanceof Error ? error.message : "保存失败，请重试";
    saving.value = false;
    await nextTick();
    editInput.value?.focus({ preventScroll: true });
    menu.value
      ?.querySelector(".select-edit-error")
      ?.scrollIntoView({ block: "nearest" });
  } finally {
    saving.value = false;
  }
}
function editKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    void saveEdit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelEdit();
  }
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
  if (props.saveOption && open.value) {
    if (event.key === "Tab") return;
    if (removing.value) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRemove();
      }
      return;
    }
    if (adding.value) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelAdd();
      }
      return;
    }
    if (editing.value) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelEdit();
      }
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-option-action]",
    );
    if (
      button &&
      !["Escape", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    )
      return;
    if (button && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home") active.value = 0;
      else if (event.key === "End")
        active.value = visibleOptions.value.length - 1;
      else move(event.key === "ArrowDown" ? 1 : -1);
      void nextTick(() =>
        document
          .getElementById(`${listId}-${active.value}`)
          ?.querySelector<HTMLElement>(
            `[data-option-action="${button.dataset.optionAction}"]`,
          )
          ?.focus(),
      );
      return;
    }
  }
  if (event.key === "Tab") {
    const footerButton = menu.value?.querySelector<HTMLButtonElement>(
      ".select-menu-footer button:not(:disabled)",
    );
    if (open.value && !props.searchable && footerButton) {
      if (!inFooter && !event.shiftKey) {
        event.preventDefault();
        footerButton.focus({ preventScroll: true });
        return;
      }
      if (inFooter && event.shiftKey) {
        event.preventDefault();
        trigger.value?.focus({ preventScroll: true });
        return;
      }
    }
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
      :role="saveOption ? undefined : 'combobox'"
      :aria-label="label"
      :aria-haspopup="saveOption ? 'dialog' : 'listbox'"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="searchable || saveOption ? undefined : activeId"
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
          :role="saveOption ? 'dialog' : undefined"
          :aria-label="saveOption ? `${label}，候选值管理` : undefined"
          :aria-busy="saveOption ? saving : undefined"
          :class="{
            'select-searchable': searchable,
            'select-with-columns': !!columns,
            'select-editable': !!saveOption,
            'select-creating': !!adding,
          }"
          :style="position"
          @keydown="keydown"
        >
          <div v-if="searchable" class="select-search">
            <Search :size="15" /><input
              ref="searchInput"
              v-model="query"
              :role="saveOption ? 'searchbox' : 'combobox'"
              :aria-label="`${label}，搜索值或别名`"
              :aria-autocomplete="saveOption ? undefined : 'list'"
              :aria-expanded="saveOption ? undefined : open"
              :aria-controls="listId"
              :aria-activedescendant="saveOption ? undefined : activeId"
              :aria-describedby="saveOption ? `${listId}-hint` : undefined"
              :disabled="!!editing || !!adding || !!removing || saving"
              placeholder="搜索值或别名"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <p v-if="saveOption" :id="`${listId}-hint`" class="sr-only">
            方向键浏览，Enter 使用；Tab 可编辑值和别名。
          </p>
          <p v-if="saveOption && !editing" class="sr-only" aria-live="polite">
            {{ visibleOptions[active]?.label }}
            {{ visibleOptions[active]?.description }}
          </p>
          <div v-if="columns" class="select-column-labels" aria-hidden="true">
            <span>{{ columns.label }}</span
            ><span>{{ columns.description }}</span
            ><span />
          </div>
          <div
            :id="listId"
            ref="optionsElement"
            :role="saveOption ? 'list' : 'listbox'"
            :aria-label="label"
            class="select-options"
          >
            <div
              v-for="(option, index) in visibleOptions"
              :id="`${listId}-${index}`"
              :key="option.value"
              :role="saveOption ? 'listitem' : 'option'"
              :aria-selected="
                saveOption ? undefined : option.value === modelValue
              "
              :aria-disabled="saveOption ? undefined : !!option.disabled"
              :title="
                saveOption
                  ? undefined
                  : [option.label, option.description]
                      .filter(Boolean)
                      .join(' · ')
              "
              class="select-option"
              :class="{
                active: active === index,
                selected: option.value === modelValue,
                unavailable: option.disabled,
                'is-editing': editing?.option.value === option.value,
              }"
              @pointermove="
                !option.disabled && !editing && !adding && (active = index)
              "
              @focusin="!editing && !adding && (active = index)"
              @pointerdown="!saveOption && $event.preventDefault()"
              @click="choose(index)"
            >
              <template v-if="saveOption">
                <span class="select-option-content">
                  <input
                    v-if="
                      editing?.option.value === option.value &&
                      editing.field === 'value'
                    "
                    :ref="setEditInput"
                    v-model="editing.text"
                    class="select-inline-input inline-value"
                    aria-label="编辑候选值"
                    :aria-invalid="!!editing.error"
                    :aria-describedby="
                      editing.error ? `${listId}-edit-error` : undefined
                    "
                    :disabled="saving"
                    :maxlength="16000"
                    autocomplete="off"
                    spellcheck="false"
                    @click.stop
                    @keydown.stop="editKeydown"
                  />
                  <span v-else class="select-cell select-option-label">
                    <span :title="option.label">{{ option.label }}</span>
                    <button
                      type="button"
                      class="select-cell-edit"
                      data-option-action="value"
                      :disabled="
                        disabled ||
                        saving ||
                        !!adding ||
                        !!removing ||
                        valueEditDisabled
                      "
                      :aria-label="
                        valueEditDisabled
                          ? '先显示敏感值后编辑'
                          : `编辑值 ${option.label}`
                      "
                      :title="
                        valueEditDisabled ? '先显示敏感值后编辑' : '编辑值'
                      "
                      @click.stop="startEdit(option, 'value')"
                    >
                      <Pencil :size="12" />
                    </button>
                  </span>
                  <input
                    v-if="
                      editing?.option.value === option.value &&
                      editing.field === 'alias'
                    "
                    :ref="setEditInput"
                    v-model="editing.text"
                    class="select-inline-input"
                    aria-label="编辑别名"
                    :aria-invalid="!!editing.error"
                    :aria-describedby="
                      editing.error ? `${listId}-edit-error` : undefined
                    "
                    :disabled="saving"
                    :maxlength="48"
                    placeholder="设置别名"
                    autocomplete="off"
                    @click.stop
                    @keydown.stop="editKeydown"
                  />
                  <span
                    v-else
                    class="select-cell select-option-description"
                    :class="{ 'is-placeholder': option.descriptionPlaceholder }"
                  >
                    <span :title="option.description || '未设置别名'">{{
                      option.description || "未设置别名"
                    }}</span>
                    <button
                      type="button"
                      class="select-cell-edit"
                      data-option-action="alias"
                      :disabled="disabled || saving || !!adding || !!removing"
                      :aria-label="`编辑 ${option.label} 的别名`"
                      title="编辑别名"
                      @click.stop="startEdit(option, 'alias')"
                    >
                      <Pencil :size="12" />
                    </button>
                  </span>
                </span>
                <span
                  v-if="editing?.option.value === option.value"
                  class="select-edit-actions"
                >
                  <button
                    type="button"
                    class="icon-button select-inline-save"
                    aria-label="保存修改"
                    :disabled="saving"
                    @click.stop="saveEdit"
                  >
                    <Check :size="15" />
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    aria-label="取消修改"
                    :disabled="saving"
                    @click.stop="cancelEdit"
                  >
                    <X :size="15" />
                  </button>
                </span>
                <span v-else class="select-row-actions">
                  <button
                    type="button"
                    class="select-use"
                    data-option-action="use"
                    :disabled="
                      disabled || saving || !!editing || !!adding || !!removing
                    "
                    :aria-pressed="option.value === modelValue"
                    :aria-label="`使用 ${option.label}`"
                    @click.stop="choose(index)"
                  >
                    <Check v-if="option.value === modelValue" :size="15" /><span
                      v-else
                      >使用</span
                    >
                  </button>
                  <button
                    v-if="removeOption"
                    type="button"
                    class="select-delete icon-button"
                    data-option-action="delete"
                    :aria-label="`删除候选值 ${option.label}`"
                    :title="
                      options.length <= 1 ? '至少保留一个候选值' : '删除候选值'
                    "
                    :disabled="
                      disabled ||
                      saving ||
                      !!editing ||
                      !!adding ||
                      !!removing ||
                      options.length <= 1
                    "
                    @click.stop="startRemove(option)"
                  >
                    <Trash2 :size="13" />
                  </button>
                </span>
                <p
                  v-if="editing?.option.value === option.value && editing.error"
                  :id="`${listId}-edit-error`"
                  class="select-edit-error"
                  role="alert"
                >
                  {{ editing.error }}
                </p>
              </template>
              <span v-else class="select-option-content"
                ><span class="select-option-label">{{ option.label }}</span
                ><span
                  v-if="option.description"
                  class="select-option-description"
                  :class="{ 'is-placeholder': option.descriptionPlaceholder }"
                  >{{ option.description }}</span
                ></span
              ><Check
                v-if="!saveOption && option.value === modelValue"
                :size="15"
              />
            </div>
            <p v-if="!visibleOptions.length" class="select-empty" role="status">
              没有匹配的值
            </p>
          </div>
          <div v-if="addLabel" class="select-menu-footer">
            <div
              v-if="removing"
              class="select-remove-confirm"
              role="group"
              aria-label="确认删除候选值"
            >
              <p>
                删除这个候选值？<span
                  v-if="removing.option.value === modelValue"
                  >删除后将使用首个剩余值。</span
                >
              </p>
              <p v-if="removing.error" class="select-create-error" role="alert">
                {{ removing.error }}
              </p>
              <div class="select-create-actions">
                <button
                  type="button"
                  class="secondary-button"
                  :disabled="saving"
                  @click="cancelRemove"
                >
                  取消
                </button>
                <button
                  ref="removeConfirm"
                  type="button"
                  class="danger-button select-remove-save"
                  :disabled="saving"
                  @click="saveRemove"
                >
                  {{ saving ? "正在删除" : "删除" }}
                </button>
              </div>
            </div>
            <form
              v-else-if="adding"
              class="select-create"
              aria-label="添加候选值"
              :aria-busy="saving"
              @submit.prevent="saveAdd"
              @keydown.stop="addKeydown"
              @click.stop
            >
              <div class="select-create-fields">
                <label :for="`${listId}-new-value`">
                  <span
                    >值<span class="select-create-optional">可为空</span></span
                  >
                  <input
                    :id="`${listId}-new-value`"
                    ref="addInput"
                    v-model="adding.value"
                    class="select-create-value"
                    aria-label="新候选值"
                    :aria-invalid="!!adding.error"
                    :aria-describedby="
                      adding.error ? `${listId}-add-error` : undefined
                    "
                    :disabled="saving"
                    :maxlength="16000"
                    placeholder="输入值"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </label>
                <label :for="`${listId}-new-alias`">
                  <span
                    >别名<span class="select-create-optional">选填</span></span
                  >
                  <input
                    :id="`${listId}-new-alias`"
                    v-model="adding.alias"
                    aria-label="新候选值别名"
                    :disabled="saving"
                    :maxlength="48"
                    placeholder="如：预发布"
                    autocomplete="off"
                  />
                </label>
              </div>
              <p
                v-if="adding.error"
                :id="`${listId}-add-error`"
                class="select-create-error"
                role="alert"
              >
                {{ adding.error }}
              </p>
              <div class="select-create-actions">
                <button
                  type="button"
                  class="secondary-button"
                  :disabled="saving"
                  @click="cancelAdd"
                >
                  取消
                </button>
                <button
                  type="submit"
                  class="primary-button select-create-save"
                  :disabled="saving"
                >
                  {{ saving ? "正在添加" : "添加并使用" }}
                </button>
              </div>
            </form>
            <button
              v-else
              type="button"
              class="select-add"
              :disabled="
                addDisabled || disabled || !!editing || !!removing || saving
              "
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
