import { useLayoutEffect, useRef } from 'preact/hooks';

/**
 * One block of kit markup. Every string comes from the kit's escaping helpers or from esc() in views.ts.
 *
 * The feed is read again every 30 seconds, and an age such as "68 seconds ago" changes each time. Preact replaces a block
 * only when its string changed, and this component then puts back what the reader had: the rows they opened and the
 * control they had focus on. Without that, a poll would close an open row and drop a keyboard user to the top of the page.
 */
export function Html({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const keyOf = (d: HTMLDetailsElement): string => d.querySelector('summary')?.id || d.querySelector('summary')?.textContent || '';
    const was = new Map([...el.querySelectorAll('details')].map((d) => [keyOf(d), d.open]));
    const active = document.activeElement;
    const had = active instanceof HTMLElement && el.contains(active);
    const focusId = had ? active.id : '';
    // A link in a row's panel has no id, so it is found again by its place among the block's controls.
    const STOPS = 'a[href], button, summary, [tabindex]';
    const focusAt = had ? [...el.querySelectorAll(STOPS)].indexOf(active) : -1;
    el.innerHTML = html;
    for (const d of el.querySelectorAll('details')) {
      const open = was.get(keyOf(d));
      if (open !== undefined) d.open = open;
    }
    const back = (focusId && document.getElementById(focusId)) || (focusAt >= 0 ? el.querySelectorAll<HTMLElement>(STOPS)[focusAt] : null);
    back?.focus({ preventScroll: true });
  }, [html]);
  return <div class="dash-block" ref={ref} />;
}
