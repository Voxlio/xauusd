/** Pure scoreboard maths over closed calls. */
import type { Call } from "./types";

export interface RankInfo {
  name: string;
  emoji: string;
  /** Human-readable requirement for this rank. */
  requirement: string;
}

export interface CallStats {
  /** Closed calls that entered the market (TP2, SL, or TP1 then SL); expired calls are not counted. */
  closed: number;
  expired: number;
  /** Wins = the call reached TP1 or TP2. */
  wins: number;
  losses: number;
  /** 0-100, null when there are no closed calls. */
  winRate: number | null;
  tp2Count: number;
  totalR: number;
  avgR: number | null;
  currentStreak: { type: "win" | "loss" | "none"; length: number };
  bestWinStreak: number;
  best: Call | null;
  worst: Call | null;
  byMode: { day: number; swing: number };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const isWin = (call: Call): boolean => call.tp1At !== undefined || call.status === "TP2_HIT";

export function computeStats(calls: readonly Call[]): CallStats {
  const sorted = [...calls].filter((c) => c.closedAt !== undefined).sort((a, b) => (a.closedAt as number) - (b.closedAt as number));
  const traded = sorted.filter((c) => c.status === "TP2_HIT" || c.status === "SL_HIT");
  const expired = sorted.filter((c) => c.status === "EXPIRED").length;
  const wins = traded.filter(isWin).length;
  const totalR = round2(traded.reduce((sum, c) => sum + (c.resultR ?? 0), 0));

  let best = 0;
  let run = 0;
  for (const c of traded) {
    run = isWin(c) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let streak: CallStats["currentStreak"] = { type: "none", length: 0 };
  for (let i = traded.length - 1; i >= 0; i--) {
    const type = isWin(traded[i]) ? "win" : "loss";
    if (streak.type === "none") streak = { type, length: 1 };
    else if (streak.type === type) streak = { type, length: streak.length + 1 };
    else break;
  }

  const byR = [...traded].sort((a, b) => (b.resultR ?? 0) - (a.resultR ?? 0));
  return {
    closed: traded.length,
    expired,
    wins,
    losses: traded.length - wins,
    winRate: traded.length === 0 ? null : Math.round((wins / traded.length) * 1000) / 10,
    tp2Count: traded.filter((c) => c.status === "TP2_HIT").length,
    totalR,
    avgR: traded.length === 0 ? null : round2(totalR / traded.length),
    currentStreak: streak,
    bestWinStreak: best,
    best: byR[0] ?? null,
    worst: byR.length > 0 ? byR[byR.length - 1] : null,
    byMode: { day: traded.filter((c) => c.mode === "day").length, swing: traded.filter((c) => c.mode === "swing").length },
  };
}

/** Rank ladder, highest first. A rank needs every condition on its row. */
export const RANKS: ReadonlyArray<RankInfo & { minClosed: number; minWinRate: number; minTotalR: number }> = [
  { name: "Gold Master", emoji: "👑", minClosed: 40, minWinRate: 60, minTotalR: 10, requirement: "40+ closed calls, win rate 60%+, total R of +10 or more" },
  { name: "Sniper", emoji: "🎯", minClosed: 15, minWinRate: 55, minTotalR: 0.01, requirement: "15+ closed calls, win rate 55%+, positive total R" },
  { name: "Apprentice", emoji: "⚔️", minClosed: 5, minWinRate: 0, minTotalR: -Infinity, requirement: "5+ closed calls" },
  { name: "Rookie", emoji: "🌱", minClosed: 0, minWinRate: 0, minTotalR: -Infinity, requirement: "Just getting started" },
];

export function rankFor(stats: Pick<CallStats, "closed" | "winRate" | "totalR">): RankInfo {
  const rate = stats.winRate ?? 0;
  const hit = RANKS.find((r) => stats.closed >= r.minClosed && rate >= r.minWinRate && stats.totalR >= r.minTotalR) ?? RANKS[RANKS.length - 1];
  return { name: hit.name, emoji: hit.emoji, requirement: hit.requirement };
}
