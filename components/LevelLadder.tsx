interface LevelLadderProps {
  riskReward1: number;
  riskReward2: number;
}

function rLabel(r: number): string {
  if (r === 0) return "0R";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(r % 1 === 0 ? 0 : 2)}R`;
}

/** Risk vs reward on an R axis: stop at −1R, entry at 0, targets to the right. */
export default function LevelLadder({ riskReward1, riskReward2 }: LevelLadderProps) {
  const span = riskReward2 + 1;
  const pos = (r: number) => `${((r + 1) / span) * 100}%`;
  const ticks = [-1, 0, riskReward1, riskReward2];

  return (
    <figure
      className="pt-6"
      aria-label={`Risk of 1R against ${riskReward1}R to TP1 and ${riskReward2}R to TP2`}
    >
      <div className="relative">
        <span
          className="num absolute bottom-3 -translate-x-1/2 whitespace-nowrap text-[12px] text-muted"
          style={{ left: pos(riskReward1) }}
        >
          <span className="text-gold">TP1</span> {rLabel(riskReward1)}
        </span>
        <div className="relative h-2 rounded-full bg-line">
          <div className="absolute inset-y-0 left-0 rounded-l-full bg-sell/80" style={{ width: pos(0) }} />
          <div className="absolute inset-y-0 right-0 rounded-r-full bg-buy/70" style={{ left: pos(0) }} />
          {ticks.map((r, i) => (
            <span
              key={i}
              className={`absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 ${i === 2 ? "bg-gold" : "bg-paper"}`}
              style={{ left: pos(r) }}
            />
          ))}
        </div>
      </div>
      <div className="num relative mt-2 h-4 text-[12px] text-muted">
        <span className="absolute left-0 whitespace-nowrap">
          <span className="text-paper">SL</span> −1R
        </span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pos(0) }}>
          <span className="text-paper">Entry</span>
        </span>
        <span className="absolute right-0 whitespace-nowrap">
          <span className="text-paper">TP2</span> {rLabel(riskReward2)}
        </span>
      </div>
    </figure>
  );
}
