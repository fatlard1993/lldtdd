// Minimal DOM component, deliberately small. Its only job is to demonstrate the
// COMPONENT_PATTERNS derivation vocabulary (see GRAMMAR.md's "Component UI classes" section),
// not to be a realistic production component.
class Base {}

export default class Toggle extends Base {
  elem: HTMLButtonElement;
  options: { value?: boolean; disabled?: boolean; onPointerPress?: (value: boolean) => void };

  constructor(options: Toggle["options"] = {}) {
    super();
    this.options = options;
    this.elem = document.createElement("button");
    this.elem.type = "button";
    this.elem.disabled = !!options.disabled;
    this.elem.classList.toggle("on", !!options.value);

    this.elem.addEventListener("pointerdown", () => {});
    this.elem.addEventListener("pointerup", () => {
      if (this.options.disabled) return;
      this.options.value = !this.options.value;
      this.elem.classList.toggle("on", !!this.options.value);
      this.options.onPointerPress?.(!!this.options.value);
    });
  }
}
