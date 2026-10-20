"use client";

import { useEffect, useRef } from "react";

export default function TradingViewWidget({
  src,
  config,
}: {
  src: string;
  config: Record<string, unknown>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.querySelector("script")) return;
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.innerHTML = JSON.stringify(config);
    el.appendChild(s);
    return () => {
      el.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="tradingview-widget-container" ref={ref} />;
}