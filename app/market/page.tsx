import Link from "next/link";
import TradingViewWidget from "@/components/TradingViewWidget";

const BASE = "https://s3.tradingview.com/external-embedding/";
const card = "overflow-hidden rounded-xl border border-line [color-scheme:light]";

export default function MarketPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 lg:px-8">
      <div className={card}>
        <TradingViewWidget
          src={BASE + "embed-widget-ticker-tape.js"}
          config={{
            symbols: [
              { proName: "OANDA:XAUUSD", title: "Gold" },
              { proName: "OANDA:XAGUSD", title: "Silver" },
              { proName: "BITSTAMP:BTCUSD", title: "Bitcoin" },
              { proName: "BITSTAMP:ETHUSD", title: "Ethereum" },
              { proName: "FX:EURUSD", title: "EUR/USD" },
            ],
            colorTheme: "dark",
            isTransparent: true,
            displayMode: "adaptive",
            locale: "en",
          }}
        />
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line py-5">
        <div>
          <h1 className="hallmark text-5xl font-extrabold text-paper">Market</h1>
          <Link href="/" className="mt-2 inline-block text-[15px] text-muted hover:text-paper">
            ← Back to signals
          </Link>
        </div>

        <div className="w-[340px] max-w-full overflow-hidden rounded-xl [color-scheme:light]">
          <div className="-m-[2px]">
            <TradingViewWidget
              src={BASE + "embed-widget-single-quote.js"}
              config={{
                symbol: "OANDA:XAUUSD",
                width: "100%",
                colorTheme: "dark",
                isTransparent: true,
                locale: "en",
              }}
            />
          </div>
        </div>
      </header>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div className={card}>
          <TradingViewWidget
            src={BASE + "embed-widget-technical-analysis.js"}
            config={{
              symbol: "OANDA:XAUUSD",
              interval: "1h",
              width: "100%",
              height: 400,
              isTransparent: true,
              showIntervalTabs: true,
              displayMode: "single",
              colorTheme: "dark",
              locale: "en",
            }}
          />
        </div>

        <div className={card}>
          <TradingViewWidget
            src={BASE + "embed-widget-events.js"}
            config={{
              width: "100%",
              height: 400,
              colorTheme: "dark",
              isTransparent: true,
              locale: "en",
              importanceFilter: "0,1",
              countryFilter: "us",
            }}
          />
        </div>
      </div>

      <p className="mt-8 border-t border-line py-5 text-[13px] text-muted">
        Prices from TradingView, may differ slightly from your broker.{" "}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener nofollow" className="underline">
          Track all markets on TradingView
        </a>
      </p>
    </div>
  );
}