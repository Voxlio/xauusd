/** Date/time helpers (pure, shared by server and client). */

const DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Parses "YYYY-MM-DD" or "YYYY-MM-DD HH:MM[:SS]" (no zone) as UTC. */
export function parseUtcDatetime(value: string): number | null {
  const m = DATETIME.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(t) ? t : null;
}

/** "YYYY-MM-DD" in UTC. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "Fri 16 Oct 12:30 UTC" */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day} ${time} UTC`;
}

/** "2h 05m", "45m", "just released" for a millisecond distance. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "just released";
  const totalMinutes = Math.round(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
