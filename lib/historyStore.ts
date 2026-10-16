/**
 * localStorage-backed store for useSyncExternalStore. Snapshots are cached by
 * the raw string so React gets a stable reference between renders. If storage
 * is unavailable (private mode, quota) history is kept in memory for the tab.
 */
import { HISTORY_KEY, parseHistory, serializeHistory, type HistoryEntry } from "./history";

const EMPTY: HistoryEntry[] = [];
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: HistoryEntry[] = EMPTY;
let memoryOnly: HistoryEntry[] | null = null;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(HISTORY_KEY);
  } catch {
    return null;
  }
}

export function getHistorySnapshot(): HistoryEntry[] {
  if (memoryOnly) return memoryOnly;
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseHistory(raw);
  }
  return cached;
}

export function getServerHistorySnapshot(): HistoryEntry[] {
  return EMPTY;
}

/** True after a write failed and history is held in memory only. */
export function isMemoryOnly(): boolean {
  return memoryOnly !== null;
}

export function subscribeHistory(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === HISTORY_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Applies `change` and persists it. Returns false when only memory could be updated. */
export function updateHistory(change: (list: HistoryEntry[]) => HistoryEntry[]): boolean {
  const next = change(getHistorySnapshot());
  let persisted = true;
  try {
    const raw = serializeHistory(next);
    window.localStorage.setItem(HISTORY_KEY, raw);
    cachedRaw = raw;
    cached = next;
    memoryOnly = null;
  } catch {
    memoryOnly = next;
    persisted = false;
  }
  for (const listener of listeners) listener();
  return persisted;
}
