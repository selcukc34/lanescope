// A small drop-down menu of buttons, opened from a toolbar button: the
// Export menu and the Trace menu. Keyboard: Enter, Space or ArrowDown on the
// button opens it on its first enabled item; ArrowUp/ArrowDown, Home and End
// move; Escape closes it and focuses the button; Tab closes it. A pointer
// down outside closes it. Disabled items are skipped.

import { h } from './dom';

export interface MenuItem {
  text: string;
  tooltip?: string;
  run(): void;
}

export class DropdownMenu {
  readonly element: HTMLElement;
  readonly items: HTMLButtonElement[];

  constructor(
    private readonly button: HTMLButtonElement,
    label: string,
    entries: MenuItem[],
    /** The element a pointer down must be outside of to close the menu (the button and the menu). */
    private readonly area: () => HTMLElement,
  ) {
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    this.items = entries.map(({ text, tooltip, run }) => {
      const item = h('button', { type: 'button', class: 'menu-item', role: 'menuitem', tabindex: '-1', ...(tooltip ? { title: tooltip } : {}) }, text);
      item.addEventListener('click', () => {
        if (item.disabled) return;
        this.close(true);
        run();
      });
      return item;
    });
    this.element = h('div', { class: 'menu', role: 'menu', 'aria-label': label, hidden: '' }, ...this.items);

    button.addEventListener('click', () => (this.isOpen ? this.close(false) : this.open()));
    button.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown') return;
      e.preventDefault();
      this.open();
    });
    this.element.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('pointerdown', (e) => {
      if (!this.area().contains(e.target as Node)) this.close(false);
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  open(): void {
    if (this.button.disabled) return;
    this.element.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.enabled()[0]?.focus();
  }

  close(focusButton: boolean): void {
    if (!this.isOpen) return;
    this.element.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (focusButton) this.button.focus();
  }

  private enabled(): HTMLButtonElement[] {
    return this.items.filter((i) => !i.disabled);
  }

  private onKey(e: KeyboardEvent): void {
    const items = this.enabled();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      this.close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (items.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      this.close(false);
      return;
    } else {
      return;
    }
    // Escape here closes the menu only; it does not go up a level.
    e.preventDefault();
    e.stopPropagation();
  }
}
