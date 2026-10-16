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

  const isWide = () => window.matchMedia('(min-width: 900px)').matches;
  const maxOffset = () => sheet.getBoundingClientRect().height - HANDLE_VISIBLE_PX;

  function offsetFor(l: SheetLevel): number {
    if (l === 'full') return 0;
    if (l === 'collapsed') return maxOffset();
    return maxOffset() * (1 - MIDDLE_FRACTION);
  }

  function apply(offset: number, animate: boolean): void {
    sheet.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
    sheet.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
  }

  function setLevel(l: SheetLevel): void {
    level = l;
    if (l !== 'collapsed') lastOpen = l;
    apply(offsetFor(l), true);
  }

  function nearestLevel(offset: number): SheetLevel {
    let best: SheetLevel = 'full';
    let bestD = Infinity;
    for (const l of ['full', 'middle', 'collapsed'] as const) {
      const d = Math.abs(offset - offsetFor(l));
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }

  handle.addEventListener('pointerdown', (e) => {
    if (isWide()) return; // the sheet is a static sidebar on wide screens
    dragging = true;
    startY = e.clientY;
    startOffset = offsetFor(level);
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    apply(Math.min(maxOffset(), Math.max(0, startOffset + e.clientY - startY)), false);
  });

  const finish = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    const dy = e.clientY - startY;
    if (Math.abs(dy) < TAP_THRESHOLD_PX) {
      setLevel(level === 'collapsed' ? lastOpen : 'collapsed');
    } else {
      setLevel(nearestLevel(Math.min(maxOffset(), Math.max(0, startOffset + dy))));
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
