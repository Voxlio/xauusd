/** Small numeric helpers shared by server and client code. */

export function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
}

export function roundOrNull(value: number | null | undefined, decimals = 2): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : round(value, decimals);
}

export function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds a price to cents, always moving away from `anchor` (so distances never shrink). */
export function roundAway(price: number, anchor: number): number {
  const cents = price * 100;
  const rounded = price >= anchor ? Math.ceil(cents - 1e-7) : Math.floor(cents + 1e-7);
  return rounded / 100;
}

export function formatPrice(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
