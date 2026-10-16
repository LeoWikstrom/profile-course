const HANDLE_VISIBLE_PX = 30;
const TAP_THRESHOLD_PX = 8;
/** Fraction of the sheet left showing at the middle stop. */
const MIDDLE_FRACTION = 0.45;

export type SheetLevel = 'collapsed' | 'middle' | 'full';

export interface SheetController {
  level(): SheetLevel;
  setLevel(level: SheetLevel): void;
  /** Collapse, remembering the current stop so restore() can return to it. */
  collapse(): void;
  /** Re-open at the stop the sheet was last opened to. */
  restore(): void;
}

/**
 * Bottom sheet with three stops. Dragging the handle snaps to the nearest one;
 * tapping it collapses an open sheet, or re-opens a collapsed one at whichever
 * stop it came from.
 */
export function initSheet(sheet: HTMLElement, handle: HTMLElement): SheetController {
  let level: SheetLevel = 'full';
  let lastOpen: Exclude<SheetLevel, 'collapsed'> = 'full';
  let dragging = false;
  let startY = 0;
  let startOffset = 0;

  // A pushed-down sheet keeps its box height, so its last items would sit below
  // the screen edge with nothing left to scroll. This spacer gives them room.
  const spacer = document.createElement('div');
  spacer.setAttribute('aria-hidden', 'true');
  sheet.appendChild(spacer);

  const isWide = () => window.matchMedia('(min-width: 900px)').matches;

  /** Sheet height with the spacer collapsed, so the stops don't feed back. */
  function naturalHeight(): number {
    const was = spacer.style.height;
    spacer.style.height = '0px';
    const h = sheet.getBoundingClientRect().height;
    spacer.style.height = was;
    return h;
  }

  const maxOffset = () => naturalHeight() - HANDLE_VISIBLE_PX;

  function offsetFor(l: SheetLevel, max = maxOffset()): number {
    if (l === 'full') return 0;
    if (l === 'collapsed') return max;
    return max * (1 - MIDDLE_FRACTION);
  }

  function apply(offset: number, animate: boolean): void {
    sheet.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
    sheet.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
  }

  function setLevel(l: SheetLevel): void {
    level = l;
    if (l !== 'collapsed') lastOpen = l;
    const offset = offsetFor(l);
    spacer.style.height = `${Math.round(offset)}px`;
    apply(offset, true);
  }

  function nearestLevel(offset: number, max: number): SheetLevel {
    let best: SheetLevel = 'full';
    let bestD = Infinity;
    for (const l of ['full', 'middle', 'collapsed'] as const) {
      const d = Math.abs(offset - offsetFor(l, max));
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }

  let dragMax = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (isWide()) return; // the sheet is a static sidebar on wide screens
    dragging = true;
    startY = e.clientY;
    dragMax = maxOffset();
    startOffset = offsetFor(level, dragMax);
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    apply(Math.min(dragMax, Math.max(0, startOffset + e.clientY - startY)), false);
  });

  // Rotating the phone changes every stop's offset.
  window.addEventListener('resize', () => {
    if (isWide()) spacer.style.height = '0px';
    else if (level !== 'full') setLevel(level);
  });

  const finish = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    const dy = e.clientY - startY;
    if (Math.abs(dy) < TAP_THRESHOLD_PX) {
      setLevel(level === 'collapsed' ? lastOpen : 'collapsed');
    } else {
      const max = maxOffset();
      setLevel(nearestLevel(Math.min(max, Math.max(0, startOffset + dy)), max));
    }
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);

  return {
    level: () => level,
    setLevel,
    collapse() {
      if (!isWide() && level !== 'collapsed') setLevel('collapsed');
    },
    restore() {
      if (!isWide() && level === 'collapsed') setLevel(lastOpen);
    },
  };
}
