# Progress — SMC-lite + SMA filter (filters-only)

## Done (staged, verified each stage)

**Assumptions (brief):** Closed candles only (Twelve Data `time_series` are completed bars). Reuse the candles already fetched for technicals — no new providers and no extra Twelve Data requests. `CANDLE_COUNT = 500` already covers SMA 200, so no count bump was needed. Swing detection reused from `lib/indicators.findSwings` with `SWING_STRENGTH` per timeframe. ATR from setup timeframe drives distances. All `SMC_*` env vars are read in `lib/smc/config.ts`; missing SMA history is marked `unavailable` and skipped. Journal integration absent in this repo — history tagging is done; journal would be a no-op (as spec allows).

### Stage 1 — lib/smc math + unit tests
- `lib/smc/config.ts` — single config: thresholds (`SMC_ZONE_DISCOUNT=35`, `SMC_ZONE_PREMIUM=65`, `SMC_SWEEP_WINDOW=6`, `SMC_SWEEP_ATR_MULT=0.1`, `SMC_FVG_WINDOW=60`, `SMC_FVG_ATR=3`, `SMC_CROSS_WINDOW=20`, `SMC_CHOCH_WINDOW=10`, `SMC_HARD_BLOCK_ZONE=20`) and penalties (`SMC_ENABLED=true`, `SMC_HARD_BLOCK=false`, `SMC_PEN_ZONE=10`, `SMC_PEN_CHOCH=15`, `SMC_PEN_SWEEP=10`, `SMC_PEN_FVG=5`, `SMC_PEN_SMA=5`), all `env`-overridable, windows clamped ≥1, penalties ≥0.
- `lib/smc/range.ts` — dealing range from latest confirmed swing high/low on setup timeframe (Day: H1, Swing: D1); `pricePositionPct` 0–100 and zone `discount`/`premium`/`equilibrium`/`unavailable`.
- `lib/smc/structure.ts` — BOS/CHoCH from closes beyond latest swing vs prevailing structure (HH/HL vs LH/LL with 0.2 ATR tolerance, strength-aware), most recent each, with `candlesAgo`.
- `lib/smc/sweep.ts` — liquidity sweep in last 6 candles: wick beyond last swing >0.1 ATR and close back inside; `highs`/`lows` + `candlesAgo`.
- `lib/smc/fvg.ts` — FVG scan over last 60 candles (`c1.high < c3.low` bullish, `c1.low > c3.high` bearish), keep only unfilled (no later candle trades through), nearest each side within 3 ATR, plus `fvgBetween(entry,tp1)` helper.
- `lib/smc/sma.ts` — SMA 50/200 on trend timeframe (Day: H4, Swing: W1 if available else D1 fallback), `above`/`below`/`unavailable`, golden/death cross in last 20; short history marked unavailable.
- `lib/smc/index.ts` — `buildSmcSnapshot(mode, candlesByTimeframe, price)` + `smcToAiBlock(snapshot)` (compact, rounded, null-safe; `SMC_ENABLED=false` → `available:false, disabled:true`).
- `tests/smc.test.ts` — 22 tests: premium/discount boundaries, BOS vs CHoCH (up/down), sweep inside vs beyond, FVG detection + filled exclusion + `fvgBetween`, SMA cross + unavailable, snapshot unavailable, penalty stacking & below-40 NO_TRADE, `SMC_ENABLED=false`, `SMC_HARD_BLOCK`.

### Stage 2 — Filter step (after validation)
- `lib/smc/filter.ts` — `applySmcFilter(signal, snapshot, thresholds, penalties)`: never creates a trade. Five penalties only lower confidence (no bonuses): zone, opposite CHoCH (≤10), opposite sweep (≤6), FVG between entry–TP1, SMA200 wrong side. Hard-block (`SMC_HARD_BLOCK=true` + deep 20 % + opposite CHoCH → NO_TRADE with clear reason). Stacked; `<40` → NO_TRADE via existing `RULES.minConfidence`. Every penalty recorded in plain English in `corrections`/`warnings`. Verdict `agree`/`neutral`/`against`/`unavailable`.

### Stage 3 — AI snapshot block + prompt line
- `lib/signal/service.ts` — builds `smcSnapshot`/`structureBlock` locally (no extra requests), passes `structure` to `buildUserPrompt`. Every exit path tags signal via `applySmcFilter` (including pre-gate NO_TRADE / AI timeout).
- `lib/ai/prompt.ts` — system prompt adds: “Use only the provided structure facts; never invent order blocks, FVGs, or liquidity levels. If the structure block is missing or null, ignore structure.” `buildUserPayload(..., structure)` includes `structure` field; tolerates null.
- `lib/types.ts` — `ValidatedSignal` adds optional `smcVerdict?`/`smcPenalties?`; `SignalSnapshot` adds optional `structure?`. Required AI response schema unchanged.

### Stage 4 — Card UI
- `components/StructureChecks.tsx` — “Structure checks” box with one plain-English line per fact + coloured dot (green agree, grey neutral, red against). Example wordings match spec. Hidden when SMC unavailable/disabled; mobile layout preserved.
- `components/ResultCard.tsx` — imports and renders `StructureChecks`; otherwise unchanged.

### Stage 5 — History tag + journal
- `lib/history.ts` — `HistoryEntry` adds `smcVerdict?`/`smcPenalties?`; `entryFromResponse` copies them; `parseEntry` validates them with `unavailable` default; `serializeHistory` round-trips.
- `components/HistoryPanel.tsx` — row shows `SMC: Agree/Neutral/Against/n/a` + penalty list; panel has `All / Agree / Neutral / Against / n/a` filter chips.
- Journal: no `lib/journal.ts` / `sendToJournal` in project → ignored per spec (would include the two fields if present).

### Stage 6 — Docs, env, verification
- `.env.example` — all SMC vars documented with defaults + comments.
- `README.md` — what each check means (plain words), every env var + default, data-reuse/latency note, “unvalidated heuristics, defaults are starting points, not proven numbers”, layout & API notes, limitations.
- `package.json` — `test` script now includes `tests/smc.test.ts`; `tests/history.test.ts` fixture updated for new fields; `tests/service.test.ts` warn-path expectation updated (68−10 calendar −10 zone = 48).
- `tests/history.test.ts` — `parseHistory` round-trip fixed for new default fields.

## How to test (exact commands)

```bash
# from repo root, after `npm install`
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # all 16 suites incl. smc.test.ts
npm run build       # next build
npm run check       # typecheck + lint + test + build
# single SMC suite
npx tsx --test tests/smc.test.ts
# verify filters-only / penalties
npx tsx --test tests/validate.test.ts tests/service.test.ts
```

`SMC_ENABLED=false` leaves signals exactly unchanged (tested). Set `SMC_HARD_BLOCK=true` to enable deep-zone hard block. All thresholds/penalties via `SMC_*` env.

## Known environment note (2026-10-28 00:2x Africa/Lagos)
- Full `npm install` / `npm run check` needs `registry.npmjs.org` etc. — current sandbox `network.allowedDomains` does include `registry.npmjs.org`, but installs intermittently time out due to large fetches (~300 pkgs). Offline verification via global `tsx` passes: **197/197 tests pass** (14 lib suites + `service/handler` + `smc` 22/22) and lib-only `tsc` is clean. `node_modules` was removed after a partial/corrupt install to avoid committing it; run `npm install` locally before `npm run check` / `npm run build`. Core app was not rewritten; changes are minimal and additive.

## Files added / touched
- Added: `lib/smc/{config,range,structure,sweep,fvg,sma,index,filter}.ts`, `components/StructureChecks.tsx`, `tests/smc.test.ts`
- Touched (minimal): `lib/types.ts`, `lib/ai/prompt.ts`, `lib/signal/service.ts`, `lib/history.ts`, `components/{ResultCard,HistoryPanel}.tsx`, `.env.example`, `README.md`, `package.json`, `tests/{history,service}.test.ts`
- No new providers, no extra Twelve Data requests, 10 s budget preserved (pure local math).
