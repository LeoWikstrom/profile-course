const DURATION_MS = 180;

const stillness = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Drop a newly shown overlay in from above. */
export function slideIn(el: HTMLElement): void {
  if (stillness()) return;
  el.animate(
    [
      { transform: 'translateY(-8px)', opacity: 0 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: DURATION_MS, easing: 'ease-out' },
  );
}

/**
 * FLIP: call before rebuilding a list to snapshot where its items are, then
 * pass the snapshot and the rebuilt elements to `playReorder` so items slide
 * from their old positions to their new ones.
 */
export function captureTops<T>(items: Iterable<[T, HTMLElement]>): Map<T, number> {
  const tops = new Map<T, number>();
  if (stillness()) return tops;
  for (const [key, el] of items) tops.set(key, el.getBoundingClientRect().top);
  return tops;
}

export function playReorder<T>(before: Map<T, number>, after: Iterable<[T, HTMLElement]>): void {
  if (stillness()) return;
  for (const [key, el] of after) {
    const was = before.get(key);
    if (was === undefined) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
      duration: DURATION_MS,
      easing: 'ease-out',
    });
  }
}
