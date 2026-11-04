"use client";

import { useRef, type KeyboardEvent } from "react";

/**
 * Accessible segmented tabs (the prototype's .seg): roving tabindex and
 * ArrowLeft/ArrowRight/Home/End, as the WAI-ARIA tabs pattern expects.
 */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  className = "seg",
  itemClass,
}: {
  items: readonly (readonly [K, string])[];
  value: K;
  onChange: (k: K) => void;
  label: string;
  className?: string;
  itemClass?: (k: K) => string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next]![0]);
    refs.current[next]?.focus();
  };
  return (
    <div className={className} role="tablist" aria-label={label}>
      {items.map(([k, l], i) => (
        <button
          key={k}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          aria-selected={value === k}
          tabIndex={value === k ? 0 : -1}
          className={[itemClass?.(k), value === k ? "on" : ""].filter(Boolean).join(" ")}
          onClick={() => onChange(k)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
