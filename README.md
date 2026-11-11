# XAUUSD Signal — Educational Gold Trade Signals (SMC-lite filters)

Educational XAU/USD (spot gold) signal app for **demo accounts only**. Multi-timeframe technicals (M15/H1/H4 for Day, H4/D1/W1 for Swing), US 10Y real yields + broad dollar (FRED), and the high-impact USD calendar (Finnhub → ForexFactory fallback) are computed **in code**. An LLM is used only for synthesis; every price the model proposes is validated server-side against hard risk rules before it reaches you.

> **Not financial advice.** Test on a demo account.

## How it works

1. **Fetch** — Twelve Data candles (3 timeframes), FRED macro series, and the calendar in parallel, each cached and counted against the 9 s budget.
2. **Technicals in code** — EMA 20/50/200, RSI 14, MACD, ATR 14, swing points, clustered support/resistance, structure (`higher-highs-lows` / `lower-highs-lows` / `mixed`), and a per-timeframe trend vote (`classifyTrend`).
3. **Hard gates** — market open (New York hours + stale-candle check), calendar `strict` vs `warn`, and a 3-hour high-impact news block. A failing gate returns `NO_TRADE` without calling the AI.
4. **AI synthesis** — the model sees only the code-computed snapshot (no raw candles) and must return a single JSON object `{bias, confidence, entry, stopLoss, takeProfit1, takeProfit2, technicalReasons, fundamentalReasons, invalidation, newsWarning}`. See `lib/ai/prompt.ts` for the exact system prompt and risk frame.
5. **Validation** — `lib/signal/validate.ts` checks entry within 0.5 × ATR, stop 1–2.5 × ATR beyond a swing, TP1 ≥ 1.5 R, TP2 ≥ 2.5 R, correct ordering, and a minimum confidence of 40. Numbers are corrected when possible (tightened stop, moved TPs), otherwise the idea is rejected as `NO_TRADE`.
6. **SMC-lite / SMA filter (optional, after validation)** — purely **confidence penalties** derived locally from the same candles (see below). Never creates a trade; only lowers confidence or turns a weak setup into `NO_TRADE`.

All I/O is injected (`lib/server/handler.ts` → `lib/signal/service.ts`), so the whole pipeline is testable offline.

## Structure checks (SMC-lite + SMA) — what each check means

These are **unvalidated heuristics** — useful context, not proven edges. Defaults are starting points, not tuned numbers. SMC-lite never opens or reverses a trade on its own.

| Check | Plain words | When it fires | Default penalty |
|---|---|---|---|
| **Dealing range / zone** | Where price sits inside the last confirmed swing high–low on the setup timeframe (Day: H1, Swing: D1). `discount` ≤ 35 %, `premium` ≥ 65 %, else `equilibrium`. Equilibrium = 50 %. | Selling while in `discount`, or buying while in `premium` | `SMC_PEN_ZONE=10` |
| **Break of structure (BOS)** | A close beyond the last confirmed swing high (bullish) or low (bearish) **in the direction of the current trend**. | Shown in the `structure` block; used as *agree* signal for the dot (no penalty). | — |
| **Change of character (CHoCH)** | The first close **against** the prevailing structure (downtrend of lower highs/lows → close above the last lower high = bullish CHoCH; mirror for uptrends). | Opposite CHoCH within the last 10 candles of the setup timeframe | `SMC_PEN_CHOCH=15` |
| **Liquidity sweep** | Within the last 6 candles, a wick pierces the last swing high/low by more than 0.1 × ATR and then **closes back inside**. | Sweep that favours the opposite side | `SMC_PEN_SWEEP=10` |
| **Fair value gaps (FVG)** | Three-candle imbalance: bullish if `candle1.high < candle3.low`, bearish if `candle1.low > candle3.high`, over the last 60 candles. Only unfilled gaps kept (no later candle traded through them), nearest on each side within 3 × ATR. | An unfilled FVG sits between entry and TP1 (likely obstacle) | `SMC_PEN_FVG=5` |
| **SMA context** | SMA 50 and SMA 200 on the trend timeframe (Day: H4, Swing: W1 if available else D1): price above/below each, and any golden/death cross in the last 20 candles. | Price on the wrong side of SMA 200 | `SMC_PEN_SMA=5` |

Agreement never raises confidence. Penalties stack; if confidence drops below 40 the signal becomes `NO_TRADE` (same existing rule). Every applied penalty is recorded in plain English in the existing `corrections`/`warnings` arrays so you can see why confidence was lowered. The `structure` block is also shown to the model with the instruction: *“Use only the provided structure facts; never invent order blocks, FVGs, or liquidity levels. If the structure block is missing or null, ignore structure.”*

### Display

- A **Structure checks** box on the signal card lists one plain-English line per fact with a coloured dot: green = agrees with the proposed side, grey = neutral, red = against. Hidden when SMC is unavailable or disabled; mobile layout preserved.
- **Signal history** stores `smcVerdict` (`agree` | `neutral` | `against` | `unavailable`) and the applied penalties per entry; the panel shows the verdict beside each row and lets you filter by it. History is localStorage-backed and survives reloads. If a journal integration (`lib/journal.ts` / `sendToJournal`) exists, the two fields are included in its payload automatically (the project currently has no journal integration, so this is a no-op).

### Data reuse & latency

All SMC-lite math is **local** and reuses the candles already fetched for technicals. No new data providers and no extra Twelve Data requests — only the candle count for H4/D1 may be raised inside the same `time_series` request if SMA 200 needs more history. Total function time stays under the existing 10 s budget (`BUDGET.totalMs = 9 s`).

## Environment variables

Copy `.env.example` → `.env.local`. All keys are read server-side only (no `NEXT_PUBLIC_` prefix).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TWELVE_DATA_API_KEY` | yes | — | Twelve Data free Basic plan |
| `FRED_API_KEY` | no | — | Free FRED key; without it macro tilt is `unknown` |
| `FINNHUB_API_KEY` | no | — | Free Finnhub key; without it the app tries the ForexFactory fallback |
| `CALENDAR_FALLBACK` | no | `forexfactory` | `forexfactory` or `none` |
| `NEWS_GATE` | no | `strict` | `strict` = `NO_TRADE` when no calendar loads; `warn` = trade with warning and −10 confidence |
| `AI_PROVIDER` | no | `anthropic` | `anthropic` or `openai` (any OpenAI-compatible host via `AI_BASE_URL`) |
| `AI_MODEL` | no | `claude-haiku-5-5` / `gpt-4.1-mini` | Must match `^[A-Za-z0-9._:/@-]{1,120}$` |
| `ANTHROPIC_API_KEY` | if anthropic | — |  |
| `OPENAI_API_KEY` | if openai | — |  |
| `AI_BASE_URL` | no | provider default | Must be https (http allowed only for localhost) |
| `AI_THINKING` | no | `off` | Anthropic only: `off` disables thinking (fast), `auto` leaves model default |
| `CACHE_TTL_SECONDS` | no | `90` | 5–300 s for macro; candles capped at 120 s regardless |
| `RATE_LIMIT_PER_MINUTE` | no | `30` | 1–120 per IP per instance |
| **`SMC_ENABLED`** | no | `true` | Master switch. `false` leaves signals exactly unchanged (useful for A/B) |
| **`SMC_HARD_BLOCK`** | no | `false` | When `true`, selling deep in discount (≤ 20 %) or buying deep in premium (≥ 80 %) **with** an opposite CHoCH becomes `NO_TRADE` with a clear reason, instead of just a penalty |
| `SMC_PEN_ZONE` | no | `10` | Penalty for selling in discount / buying in premium |
| `SMC_PEN_CHOCH` | no | `15` | Opposite CHoCH within last 10 candles |
| `SMC_PEN_SWEEP` | no | `10` | Opposite-side sweep within last 6 |
| `SMC_PEN_FVG` | no | `5` | Unfilled FVG between entry and TP1 |
| `SMC_PEN_SMA` | no | `5` | Price on wrong side of SMA 200 |
| `SMC_ZONE_DISCOUNT` | no | `35` | ≤ this % is discount |
| `SMC_ZONE_PREMIUM` | no | `65` | ≥ this % is premium |
| `SMC_SWEEP_WINDOW` | no | `6` | Lookback (candles) for sweep |
| `SMC_SWEEP_ATR_MULT` | no | `0.1` | Wick must exceed this × ATR |
| `SMC_FVG_WINDOW` | no | `60` | Scan window (candles) for FVGs |
| `SMC_FVG_ATR` | no | `3` | Keep only FVGs within this × ATR |
| `SMC_CROSS_WINDOW` | no | `20` | Lookback for SMA golden/death cross |
| `SMC_CHOCH_WINDOW` | no | `10` | “Opposite CHoCH within N candles” |
| `SMC_HARD_BLOCK_ZONE` | no | `20` | Deepest percentile for hard block (20 = ≤ 20 % or ≥ 80 %) |

All `SMC_*` thresholds and penalties are defined in `lib/smc/config.ts` (single config file) and overridable by env. Missing history (SMA 50 needs 50 closes, SMA 200 needs 200) is marked `unavailable` and skipped silently. Integer penalties are clamped to ≥ 0.

## API

`POST /api/signal` with `{"mode":"day"}` or `{"mode":"swing"}`. Response is `SignalResponse` (`lib/types.ts`): `signal` (validated, SMC-filtered), `snapshot` (technicals + macro + calendar + `structure` block), `meta` (provider, model, durations). `structure` and `signal.smcVerdict` / `signal.smcPenalties` are optional for backwards compat. `GET` is rejected (405).

## Development

Prerequisites: Node ≥ 20.9, `.env.local` with at least `TWELVE_DATA_API_KEY` and one AI key.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # tsx --test tests/*.test.ts (including smc.test.ts)
npm run build       # next build
npm run check       # typecheck + lint + test + build
```

Tests are pure (no network): `tests/helpers.ts` builds candles from closes or high/low pairs, `tests/fakes.ts` scripts fetch, `tests/market.ts` aggregates M15 → H1/H4 and fakes Twelve Data/FRED/Finnhub payloads. SMC tests in `tests/smc.test.ts` cover premium/discount boundaries (35/65), BOS vs CHoCH in uptrend/downtrend, sweep that closes back inside vs beyond (not a sweep), FVG detection and filled gap, SMA cross and unavailable cases, penalty stacking and the below-40 `NO_TRADE` case, `SMC_ENABLED=false` leaving signals unchanged, and `SMC_HARD_BLOCK` behaviour.

## Limitations

- SMC-lite checks are **unvalidated heuristics** with arbitrary defaults. They have not been back-tested; treat them as context, not a strategy.
- Timeframes and swing detection use a simple fractal pivot (`SWING_STRENGTH` 3 on H1/H4/M15, 2 on D1/W1); different strength or instrument would give different swings.
- Market-hours gate uses New York time and a fixed 90 min stale-candle rule; holidays beyond weekends are not modelled.
- The LLM can still hallucinate reasons; prices and risk rules are always enforced in code, and confidence is lowered for conflicts the model may have glossed over.

## Project layout

- `app/` — Next.js App Router (`page.tsx`, `market/page.tsx`, `api/signal/route.ts`)
- `lib/config.ts`, `lib/indicators.ts`, `lib/technicals.ts`, `lib/num.ts` — domain config & pure math
- `lib/data/` — Twelve Data / FRED / calendar clients
- `lib/ai/` — provider abstraction + prompt
- `lib/signal/` — `facts.ts`, `gates.ts`, `levels.ts`, `parse.ts`, `validate.ts`, `service.ts` (pipeline)
- `lib/smc/` — `config.ts`, `range.ts`, `structure.ts`, `sweep.ts`, `fvg.ts`, `sma.ts`, `index.ts`, `filter.ts` (SMC-lite, pure, no I/O)
- `lib/history.ts` / `lib/historyStore.ts` / `components/HistoryPanel.tsx` — browser history
- `components/` — `SignalApp.tsx`, `ResultCard.tsx`, `StructureChecks.tsx`, `SnapshotDetails.tsx`, etc.
- `tests/` — offline unit tests (`*.test.ts`)
