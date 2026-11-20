// The log (docs/design/m2.md 4.4): the CLI's exact lines, rendered once per opened fight; the
// current line's highlight and scroll move by toggling a class on two nodes, so a scrub frame
// touches two DOM nodes, not the whole log. Line j is events[j + 1] (renderLog skips fightStart).

import { memo, useEffect, useRef } from 'react';

const Lines = memo(function Lines({ lines, onPick }: { lines: readonly string[]; onPick: (j: number) => void }) {
  return (
    <>
      {lines.map((l, j) => (
        // Not tab stops (a fight has thousands of lines): keyboard users step to an event and use
        // "WHY of this event" (or w) instead.
        <div key={j} data-j={j} className="logline" onClick={() => onPick(j)}>
          {l}
        </div>
      ))}
    </>
  );
});

export function LogPane({ lines, current, onPick }: { lines: readonly string[]; current: number; onPick: (j: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const prev = useRef<Element | null>(null);
  useEffect(() => {
    const el = current >= 0 ? box.current?.querySelector(`[data-j="${current}"]`) : null;
    if (prev.current && prev.current !== el) prev.current.classList.remove('current');
    const b = box.current;
    if (el instanceof HTMLElement && b) {
      el.classList.add('current');
      // Scroll the log box only (scrollIntoView would scroll the page too).
      const top = el.offsetTop;
      if (top < b.scrollTop) b.scrollTop = top - 8;
      else if (top + el.offsetHeight > b.scrollTop + b.clientHeight) b.scrollTop = top + el.offsetHeight - b.clientHeight + 8;
    }
    prev.current = el ?? null;
  }, [current, lines]);
  return (
    <div className="log mono" ref={box}>
      <Lines lines={lines} onPick={onPick} />
    </div>
  );
}
