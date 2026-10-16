# XAUUSD Signal

An educational trade-signal app for **XAU/USD (spot gold)**, built for practice on a **demo account**. Press **Analyze XAUUSD** and you get a bias (BUY / SELL / NO TRADE) with entry, stop loss, two take-profits and risk:reward, or a clear reason not to trade.

> **Educational use only. Not financial advice. Test on a demo account.**

## How it works

```
Analyze ──► POST /api/signal {mode}
              │
              ├─ fetch in parallel (timeouts, 60 s cache, stale fallback)
              │    Twelve Data  XAU/USD candles (3 timeframes)
              │    FRED         10Y real yield (DFII10) + broad dollar index (DTWEXBGS)
              │    Finnhub      high-impact USD events, 48 h  ──► ForexFactory fallback
              │
              ├─ technicals in TypeScript (lib/indicators.ts, lib/technicals.ts)
              │    EMA 20/50/200, RSI 14, MACD 12/26/9, ATR 14, swings, S/R, trend
              │
              ├─ hard gates: market closed? stale prices? calendar missing? USD news within 3 h? ──► NO TRADE
              │
              ├─ AI gets a compact JSON summary (no raw candles) and must reply with JSON only
              │
              └─ validate and correct every number in code ──► signal + indicator snapshot
```

| Mode  | Trigger | Setup (ATR source) | Trend |
| ----- | ------- | ------------------ | ----- |
| Day   | M15     | H1                 | H4    |
| Swing | H4      | D1                 | W1    |

### Risk rules enforced in code (`lib/signal/validate.ts`)

The model only proposes. Every number shown to you is checked or recomputed:

| Rule | What happens if the model breaks it |
| --- | --- |
| Entry within **0.5× ATR** of the current price | NO TRADE |
| Stop **1× to 2.5× ATR** from entry | widened or tightened to the limit |
| Stop **beyond the nearest swing** low/high (+0.1× ATR buffer) | moved beyond it; NO TRADE if that needs more than 2.5× ATR |
| TP1 **≥ 1.5R**, TP2 **≥ 2.5R** (and ≥ TP1 + 0.5R) | extended; capped at 6R / 10R |
| Levels on the wrong side, missing, or >15% from price | NO TRADE |
| High-impact USD event from 15 min ago to **3 h ahead** | NO TRADE (checked before and after the AI) |
| No calendar source could be loaded | NO TRADE with `NEWS_GATE=strict` (default); −10 confidence with `NEWS_GATE=warn` |
| Gold market closed (Fri 17:00 to Sun 18:00 New York, daily 17:00–18:00 break) or the newest candle is stale | NO TRADE, AI not called |
| Confidence below 40 after penalties (counter-trend −15, macro against −10, no trend timeframe −10, no calendar −10) | NO TRADE |
| Unparseable AI reply, AI timeout | NO TRADE, no AI numbers used |

A final invariant check re-verifies every published BUY/SELL; a 4,000-case fuzz test confirms no published signal breaks a rule.

## API keys you need

| Service | Needed? | Free tier | Get a key |
| --- | --- | --- | --- |
| **Twelve Data** | Required | Basic: 8 requests/min, 800/day | https://twelvedata.com/pricing |
| **Anthropic** | Required (default AI) | Paid per token; Haiku is cheap | https://console.anthropic.com/settings/keys |
| **FRED** | Recommended | Free | https://fredaccount.stlouisfed.org/apikeys |
| **Finnhub** | Optional | Free key, but the economic calendar is often premium (HTTP 403) | https://finnhub.io/register |

Without Finnhub access the app uses the free ForexFactory weekly calendar automatically. If neither calendar loads, the app returns NO TRADE (set `NEWS_GATE=warn` to change that). Without FRED, fundamentals are limited to the calendar.

Each analysis uses 3 Twelve Data requests (cached for 60 s), so the free plan allows about 2 fresh analyses per minute.

## Local setup

Requires **Node.js 20.9 or newer** (22 LTS recommended).

```bash
npm install
cp .env.example .env.local        # Windows (cmd): copy .env.example .env.local
# edit .env.local and add TWELVE_DATA_API_KEY, ANTHROPIC_API_KEY, FRED_API_KEY (and FINNHUB_API_KEY if you have one)
npm run dev
```

Open http://localhost:3000.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm test` | Unit tests (indicators, validation, data parsers, API handler, history) — no keys or network needed |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run check` | All of the above in order |

Quick API test while `npm run dev` is running:

```bash
curl -s -X POST http://localhost:3000/api/signal -H "content-type: application/json" -d '{"mode":"day"}'
```

## Deploy to Vercel (free Hobby plan)

1. Push this folder to a GitHub repository (`.env.local` is git-ignored, so keys stay local).
2. In Vercel, choose **Add New → Project** and import the repository. The framework is detected as Next.js; keep the defaults.
3. Under **Environment Variables**, add the variables from the table below (at least `TWELVE_DATA_API_KEY` and `ANTHROPIC_API_KEY`).
4. Click **Deploy**. Changing variables later needs a redeploy (**Deployments → ⋯ → Redeploy**).

With the Vercel CLI instead: `npm i -g vercel`, then `vercel`, add each key with `vercel env add NAME`, and `vercel --prod`.

The app uses one serverless function (`/api/signal`, Node.js runtime, `maxDuration = 10`), no database and no paid Vercel features.

## Environment variables

All are server-side only (no `NEXT_PUBLIC_` prefix), so they never reach the browser.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TWELVE_DATA_API_KEY` | Yes | — | XAU/USD candles |
| `ANTHROPIC_API_KEY` | When `AI_PROVIDER=anthropic` | — | Anthropic API key |
| `OPENAI_API_KEY` | When `AI_PROVIDER=openai` | — | OpenAI or OpenAI-compatible key |
| `FRED_API_KEY` | No | — | Real yield and dollar index |
| `FINNHUB_API_KEY` | No | — | Economic calendar (premium on many keys) |
| `CALENDAR_FALLBACK` | No | `forexfactory` | `forexfactory` or `none` |
| `NEWS_GATE` | No | `strict` | `strict`: NO TRADE when no calendar loads. `warn`: allow trades with a warning and −10 confidence |
| `AI_PROVIDER` | No | `anthropic` | `anthropic` or `openai` |
| `AI_MODEL` | No | `claude-haiku-5-5` / `gpt-4.1-mini` | Model ID for the chosen provider |
| `AI_BASE_URL` | No | provider default | HTTPS base URL for OpenAI-compatible hosts (Groq, OpenRouter, …) or an Anthropic proxy |
| `AI_THINKING` | No | `off` | Anthropic only. `off` disables extended thinking for speed; `auto` uses the model default (slower) |
| `CACHE_TTL_SECONDS` | No | `60` | In-memory cache for macro data, 5–300. Candles are capped at 120 s so prices stay current |
| `RATE_LIMIT_PER_MINUTE` | No | `10` | Analyses per IP per minute, per server instance, 1–120 |

### Switching the AI model

The AI sits behind a small interface (`lib/ai/provider.ts`) with two implementations:

- **Anthropic** (default): `AI_PROVIDER=anthropic`, `AI_MODEL=claude-haiku-5-5` (fast enough for the 10 s budget). Larger models such as `claude-sonnet-5-5` can be slower than the time budget allows.
- **OpenAI-compatible**: `AI_PROVIDER=openai`, `AI_MODEL=gpt-4.1-mini`, and optionally `AI_BASE_URL` (for example `https://api.groq.com/openai/v1`). It uses Chat Completions with JSON mode and `max_completion_tokens`. Prefer non-reasoning models: reasoning tokens use up the output limit and the 10 s budget.

Adding another vendor means one file that implements `complete({ system, user, maxTokens, timeoutMs })`.

## API

`POST /api/signal` with `Content-Type: application/json` and body `{"mode":"day"}` or `{"mode":"swing"}`. Any other field, type or value is rejected.

**200** returns `{ signal, snapshot, meta }`:

- `signal`: `bias`, `confidence`, `entry`, `entryType` (market / limit / stop), `stopLoss`, `takeProfit1`, `takeProfit2`, `riskReward1`, `riskReward2`, `riskUsd`, `stopAtr`, `technicalReasons[]`, `fundamentalReasons[]`, `invalidation`, `newsWarning`, `noTradeReasons[]`, `corrections[]`, `warnings[]`, `decidedBy` (`ai` or `rules`)
- `snapshot`: price, ATR, per-timeframe indicators and levels, macro readings, 48 h calendar, and the status of each data source
- `meta`: provider, model, durations

**Errors** return `{ error: { code, message, hint } }`:

| Status | Codes |
| --- | --- |
| 400 | `INVALID_JSON`, `INVALID_BODY`, `MISSING_MODE`, `INVALID_MODE`, `UNKNOWN_FIELD` |
| 403 | `FORBIDDEN_ORIGIN` (cross-site browser request) |
| 405 / 413 / 415 | wrong method, body over 1 KB, wrong content type |
| 429 | `RATE_LIMITED` (with `Retry-After`) |
| 500 | `CONFIG_MISSING`, `CONFIG_INVALID`, `INTERNAL_ERROR` |
| 502 | `MARKET_DATA_UNAVAILABLE`, `INSUFFICIENT_DATA`, `AI_CONFIG` |

## Project structure

```
app/
  api/signal/route.ts     POST handler (delegates to lib/server/handler.ts)
  layout.tsx, page.tsx    Page shell and font
  globals.css             Tailwind v4 theme
components/               SignalApp, ModeToggle, AnalyzeButton, ResultCard, LevelLadder,
                          SnapshotDetails, HistoryPanel
lib/
  indicators.ts           EMA, RSI, MACD, ATR, swings, structure, S/R, trend (pure)
  technicals.ts           Per-timeframe snapshot and multi-timeframe summary (pure)
  fundamentals.ts         Macro tilt, 48 h calendar window, 3 h news gate (pure)
  marketHours.ts          Spot gold session in New York time, DST aware (pure)
  data/                   Twelve Data, FRED and calendar clients
  ai/                     Provider interface, Anthropic, OpenAI-compatible, prompt
  signal/                 parse, validate, gates, levels, request, service (the pipeline)
  server/                 env, cache, http, errors, rate limit, handler
  history.ts              History stats and storage format (pure)
  historyStore.ts         localStorage binding for React
  clientApi.ts            Browser call to the API
tests/                    node:test suites run with tsx
```

## Limitations

- **Educational tool.** Signals are rule-checked, not back-tested. No edge is claimed. Use a demo account.
- **Data delays.** Free Twelve Data quotes can be delayed. The latest candle is still forming, so indicators move until it closes.
- **Market hours.** The app knows the weekly close (Friday 17:00 to Sunday 18:00 New York) and the daily 17:00–18:00 break, but not exchange holidays. On holidays the stale-candle check usually catches the closed market.
- **Macro lag.** FRED series are daily and published with a lag of one or more days. They describe the backdrop, not intraday moves.
- **Calendar coverage.** The ForexFactory fallback is an unofficial feed covering the current week only, so on Fridays it can miss Monday's events. Check a calendar yourself before trading.
- **Per-instance state.** The cache and rate limiter live in memory per serverless instance; they reset on cold starts and are not shared between instances.
- **History is local.** Signal history lives in this browser's localStorage. Clearing site data deletes it, and it doesn't sync across devices. "TP hit" counts as TP1 reached.
- **AI variability.** The same data can produce different reasons or a different bias between runs. Only the levels are guaranteed to follow the rules.
- **Time budget.** The function aims to finish in under 9 s. If data sources are slow, the AI step is skipped and you get NO TRADE with the reason.
