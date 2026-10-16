import { MODE_TIMEFRAMES } from "@/lib/config";
import type { Mode } from "@/lib/types";

const OPTIONS: ReadonlyArray<{ mode: Mode; label: string; hold: string }> = [
  { mode: "day", label: "Day", hold: "Hours" },
  { mode: "swing", label: "Swing", hold: "Days to weeks" },
];

interface ModeToggleProps {
  mode: Mode;
  disabled: boolean;
  onChange: (mode: Mode) => void;
}

export default function ModeToggle({ mode, disabled, onChange }: ModeToggleProps) {
  return (
    <fieldset disabled={disabled} className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-panel p-1 disabled:opacity-70">
      <legend className="sr-only">Trading style</legend>
      {OPTIONS.map((o) => (
        <label
          key={o.mode}
          className="cursor-pointer rounded-md px-4 py-3 transition-colors hover:bg-raised/60 has-[:checked]:bg-raised has-[:checked]:shadow-[inset_0_-2px_0_var(--color-gold)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-gold-bright"
        >
          <input
            type="radio"
            name="mode"
            value={o.mode}
            checked={mode === o.mode}
            onChange={() => onChange(o.mode)}
            className="sr-only"
          />
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-base font-semibold text-paper">{o.label}</span>
            <span className="text-[12px] text-muted">{o.hold}</span>
          </span>
          <span className="num mt-0.5 block text-[13px] text-muted">{MODE_TIMEFRAMES[o.mode].join(" / ")}</span>
        </label>
      ))}
    </fieldset>
  );
}
