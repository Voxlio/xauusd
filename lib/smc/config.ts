/** SMC-lite thresholds and penalty config — all overridable by env. */

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() === "true" || raw.trim() === "1";
}

export interface SmcThresholds {
  zoneDiscount: number; // <= this is discount
  zonePremium: number; // >= this is premium
  sweepWindow: number; // last N candles to look for a sweep
  sweepAtrMult: number; // wick beyond swing must exceed this * ATR
  fvgWindow: number; // last N candles to scan for FVGs
  fvgMaxAtr: number; // only keep FVGs within this * ATR of price
  crossWindow: number; // last N candles to look for SMA cross
  chochLookback: number; // for filter: opposite CHoCH within this many candles
  hardBlockZone: number; // deepest percentile for hard block (20 means <=20 or >=80)
}

export interface SmcPenalties {
  enabled: boolean;
  hardBlock: boolean;
  penZone: number;
  penChoch: number;
  penSweep: number;
  penFvg: number;
  penSma: number;
}

export function getSmcThresholds(): SmcThresholds {
  return {
    zoneDiscount: envNum("SMC_ZONE_DISCOUNT", 35),
    zonePremium: envNum("SMC_ZONE_PREMIUM", 65),
    sweepWindow: Math.max(1, Math.round(envNum("SMC_SWEEP_WINDOW", 6))),
    sweepAtrMult: envNum("SMC_SWEEP_ATR_MULT", 0.1),
    fvgWindow: Math.max(3, Math.round(envNum("SMC_FVG_WINDOW", 60))),
    fvgMaxAtr: envNum("SMC_FVG_ATR", 3),
    crossWindow: Math.max(1, Math.round(envNum("SMC_CROSS_WINDOW", 20))),
    chochLookback: Math.max(1, Math.round(envNum("SMC_CHOCH_WINDOW", 10))),
    hardBlockZone: Math.max(5, Math.round(envNum("SMC_HARD_BLOCK_ZONE", 20))),
  };
}

export function getSmcPenalties(): SmcPenalties {
  return {
    enabled: envBool("SMC_ENABLED", true),
    hardBlock: envBool("SMC_HARD_BLOCK", false),
    penZone: Math.max(0, Math.round(envNum("SMC_PEN_ZONE", 10))),
    penChoch: Math.max(0, Math.round(envNum("SMC_PEN_CHOCH", 15))),
    penSweep: Math.max(0, Math.round(envNum("SMC_PEN_SWEEP", 10))),
    penFvg: Math.max(0, Math.round(envNum("SMC_PEN_FVG", 5))),
    penSma: Math.max(0, Math.round(envNum("SMC_PEN_SMA", 5))),
  };
}
