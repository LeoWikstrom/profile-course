const HANDLE_VISIBLE_PX = 30;
const TAP_THRESHOLD_PX = 8;

/** Drag or tap the handle to collapse the bottom sheet down to just the handle. */
export function initSheet(sheet: HTMLElement, handle: HTMLElement): void {
  let collapsed = false;
  let dragging = false;
  let startY = 0;
  let startOffset = 0;

  const maxOffset = () => sheet.getBoundingClientRect().height - HANDLE_VISIBLE_PX;

  function apply(offset: number, animate: boolean): void {
    sheet.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
    sheet.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
  }

  function setCollapsed(value: boolean): void {
    collapsed = value;
    apply(value ? maxOffset() : 0, true);
  }

  handle.addEventListener('pointerdown', (e) => {
    // The sheet becomes a static sidebar on wide screens.
    if (window.matchMedia('(min-width: 900px)').matches) return;
    dragging = true;
    startY = e.clientY;
    startOffset = collapsed ? maxOffset() : 0;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const offset = Math.min(maxOffset(), Math.max(0, startOffset + e.clientY - startY));
    apply(offset, false);
  });

  const finish = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    const dy = e.clientY - startY;
    if (Math.abs(dy) < TAP_THRESHOLD_PX) {
      setCollapsed(!collapsed);
    } else {
      const offset = Math.min(maxOffset(), Math.max(0, startOffset + dy));
      setCollapsed(offset > maxOffset() / 2);
    }
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}
