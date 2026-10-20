"use client";

import { useEffect, useRef } from "react";

export default function GoldPriceWidget() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.querySelector("script")) return;

    const s = document.createElement("script");
    s.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-single-quote.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      symbol: "OANDA:XAUUSD",
      width: "100%",
      colorTheme: "dark",
      isTransparent: true,
      locale: "en",
    });
    el.appendChild(s);

    return () => {
      el.innerHTML = "";
    };
  }, []);

  return <div className="tradingview-widget-container" ref={ref} />;
}