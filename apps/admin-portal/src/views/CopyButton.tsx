import { useEffect, useRef, useState } from "react";
import { copyText } from "../token";

/** A Copy button that turns into "Copied" for a moment after copying, so no separate notice is needed. */
export function CopyButton({
  value, className = "ghost", label = "Copy", resetMs = 2500,
}: { value: string; className?: string; label?: string; resetMs?: number }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), resetMs);
  }

  return (
    <button type="button" className={className} onClick={() => void copy()} aria-live="polite">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy Failed" : label}
    </button>
  );
}
