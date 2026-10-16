/**
 * Spot gold (XAU/USD) trading session, in New York time so daylight saving is
 * handled: open Sunday 18:00 to Friday 17:00, with a daily break 17:00-18:00.
 * Holidays are not modelled; the stale-candle gate catches those.
 */

export interface MarketSession {
  open: boolean;
  reason: string | null;
}

const NY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function newYorkTime(ms: number): { weekday: string; hour: number; minute: number } {
  const parts = NY_FORMAT.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

const WEEKEND = "Spot gold is closed for the weekend; it reopens Sunday 18:00 New York time.";
const DAILY_BREAK = "Spot gold is in its daily break (17:00-18:00 New York time).";

export function goldMarketSession(now: number): MarketSession {
  const { weekday, hour } = newYorkTime(now);
  if (weekday === "Sat") return { open: false, reason: WEEKEND };
  if (weekday === "Sun" && hour < 18) return { open: false, reason: WEEKEND };
  if (weekday === "Fri" && hour >= 17) return { open: false, reason: WEEKEND };
  if (hour === 17) return { open: false, reason: DAILY_BREAK };
  return { open: true, reason: null };
}
