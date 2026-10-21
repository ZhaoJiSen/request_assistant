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
import { Check, ChevronDown } from "lucide-vue-next";
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
const props = defineProps<{
  modelValue: string;
  options: SelectOption[];
  label: string;
  id?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const unique = useId();
const listId = `select-${unique}`;
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const open = ref(false);
const active = ref(-1);
const position = ref({
  top: "0px",
  left: "0px",
  width: "0px",
  maxHeight: "240px",
});
const selected = computed(() =>
  props.options.find((o) => o.value === props.modelValue),
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
  // The editor starts its transition across Vue's next animation frames.
  // Follow transformed anchors for as long as the menu is open, including
  // the frames before a transition becomes observable through getAnimations.
  placementFrame = requestAnimationFrame(followAnimatedTrigger);
}
function place() {
  if (!open.value || !trigger.value) return;
  const r = trigger.value.getBoundingClientRect();
  const viewportWidth = Math.min(
    innerWidth,
    document.documentElement.clientWidth,
  );
  const width = Math.min(Math.max(r.width, 168), viewportWidth - 16);
  const desired = Math.min((menu.value?.scrollHeight ?? 238) + 2, 280);
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
async function show() {
  if (props.disabled) return;
  document.dispatchEvent(
    new CustomEvent("request-helper:select-open", { detail: listId }),
  );
  active.value = props.options.findIndex(
    (o) => o.value === props.modelValue && !o.disabled,
  );
  if (active.value < 0)
    active.value = props.options.findIndex((o) => !o.disabled);
  open.value = true;
  await nextTick();
  place();
  placementFrame = requestAnimationFrame(followAnimatedTrigger);
  scrollActive();
}
function scrollActive() {
  void nextTick(() =>
    document
      .getElementById(`${listId}-${active.value}`)
      ?.scrollIntoView({ block: "nearest" }),
  );
}
function choose(index: number) {
  const option = props.options[index];
  if (!option || option.disabled || props.disabled) return;
  close(true);
  if (option.value !== props.modelValue)
    emit("update:modelValue", option.value);
}
function move(direction: number) {
  const count = props.options.length;
  for (let step = 1; step <= count; step++) {
    const i = (active.value + direction * step + count * 2) % count;
    if (!props.options[i]?.disabled) {
      active.value = i;
      scrollActive();
      return;
    }
  }
}
function keydown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === "Tab") {
    close();
    return;
  }
  if (event.key === "Escape" && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
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
      const indices = props.options
        .map((_, i) => i)
        .filter((i) => !props.options[i]!.disabled);
      active.value = (event.key === "Home" ? indices[0] : indices.at(-1)) ?? -1;
      scrollActive();
    } else move(event.key === "ArrowDown" ? 1 : -1);
  } else if (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    search += event.key.toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      search = "";
    }, 600);
    const index = props.options.findIndex(
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
      :aria-activedescendant="
        open && active >= 0 ? `${listId}-${active}` : undefined
      "
      :title="selected?.label"
      :disabled="disabled"
      :class="{ 'is-open': open }"
      @click="open ? close() : show()"
      @keydown="keydown"
    >
      <slot name="leading" />
      <span class="select-value">{{ selected?.label || "请选择" }}</span>
      <ChevronDown
        :size="15"
        :class="{ rotated: open }"
        class="select-chevron"
      />
    </button>
    <Teleport to="body">
      <Transition name="select-menu">
        <div v-if="open" ref="menu" class="select-popover" :style="position">
          <div
            :id="listId"
            role="listbox"
            :aria-label="label"
            class="select-options"
          >
            <div
              v-for="(option, index) in options"
              :id="`${listId}-${index}`"
              :key="option.value"
              role="option"
              :aria-selected="option.value === modelValue"
              :aria-disabled="!!option.disabled"
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
              <span>{{ option.label }}</span
              ><Check v-if="option.value === modelValue" :size="15" />
            </div>
          </div>
          <div v-if="$slots.footer" class="select-menu-footer" @click="close()">
            <slot name="footer" />
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
