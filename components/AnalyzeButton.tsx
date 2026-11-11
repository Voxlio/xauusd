interface AnalyzeButtonProps {
  loading: boolean;
  onClick: () => void;
}

/** The ingot: the one metallic, shaped surface on the page. */
export default function AnalyzeButton({ loading, onClick }: AnalyzeButtonProps) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        aria-busy={loading}
        className="group block w-full rounded-sm focus-visible:outline-offset-4 disabled:cursor-wait"
      >
        <span className="ingot hallmark flex min-h-16 items-center justify-center px-6 text-lg font-extrabold text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-[filter] [clip-path:polygon(2.5%_0,97.5%_0,100%_100%,0_100%)] group-hover:brightness-110 group-active:brightness-95 group-disabled:brightness-75 sm:min-h-[4.5rem] sm:text-xl">
          {loading ? "Analyzing…" : "Analyze XAUUSD"}
        </span>
      </button>
      <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
        {loading && <div className="progress-run h-full origin-left bg-gold" />}
      </div>
      <p className="mt-2 text-[13px] text-muted" aria-live="polite">
        {loading
          ? "Fetching prices, real yields, the dollar and the USD calendar, then checking every level."
          : "Runs only when you press it and takes up to 10 seconds."}
      </p>
    </div>
  );
}
