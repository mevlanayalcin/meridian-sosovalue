import React, { useState } from "react";
import type { BacktestPoint, OrderbookSnapshot } from "../../shared/types";

export function EquityCurveChart({ points }: { points: BacktestPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!points.length) {
    return (
      <div className="h-64 flex items-center justify-center text-xs text-slate-500 border border-slate-800/80 rounded-lg bg-slate-950/50">
        Run backtest to render equity curve
      </div>
    );
  }

  const w = 760;
  const h = 250;
  const pad = { top: 18, right: 20, bottom: 28, left: 48 };
  const allVals = points.flatMap((p) => [p.portfolioValue, p.benchmarkSsiValue, p.benchmarkBtcValue]);
  const minVal = Math.min(...allVals) * 0.985;
  const maxVal = Math.max(...allVals) * 1.015;
  const span = Math.max(0.01, maxVal - minVal);

  const xOf = (i: number) => pad.left + (i / Math.max(1, points.length - 1)) * (w - pad.left - pad.right);
  const yOf = (v: number) => h - pad.bottom - ((v - minVal) / span) * (h - pad.top - pad.bottom);

  const pathFor = (key: "portfolioValue" | "benchmarkSsiValue" | "benchmarkBtcValue") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(p[key]).toFixed(1)}`).join(" ");

  const activePt = hoverIdx !== null ? points[hoverIdx] : points[points.length - 1];

  return (
    <div className="bg-slate-950/70 border border-slate-800/90 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-cyan-300 font-medium">
            <span className="w-2.5 h-0.5 bg-cyan-400 inline-block" /> Meridian Basket ({activePt.portfolioValue.toFixed(2)})
          </span>
          <span className="flex items-center gap-1.5 text-violet-300">
            <span className="w-2.5 h-0.5 bg-violet-400 inline-block" /> MAG7.ssi ({activePt.benchmarkSsiValue.toFixed(2)})
          </span>
          <span className="flex items-center gap-1.5 text-amber-300">
            <span className="w-2.5 h-0.5 bg-amber-400 inline-block" /> BTC ({activePt.benchmarkBtcValue.toFixed(2)})
          </span>
        </div>
        <span className="text-[11px] font-mono text-slate-400">
          {activePt.date} · DD {activePt.drawdownPct.toFixed(2)}%
        </span>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-56 overflow-visible select-none"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * w;
          const idx = Math.round(((relX - pad.left) / (w - pad.left - pad.right)) * (points.length - 1));
          setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
        }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const val = minVal + t * span;
          const y = yOf(val);
          return (
            <g key={t}>
              <line x1={pad.left} x2={w - pad.right} y1={y} y2={y} stroke="#1e293b" strokeDasharray="3 3" />
              <text x={pad.left - 8} y={y + 3} textAnchor="end" className="fill-slate-500 text-[10px] font-mono">
                {val.toFixed(1)}
              </text>
            </g>
          );
        })}

        <path d={pathFor("benchmarkBtcValue")} fill="none" stroke="#f59e0b" strokeWidth="1.4" strokeOpacity="0.65" />
        <path d={pathFor("benchmarkSsiValue")} fill="none" stroke="#a78bfa" strokeWidth="1.6" strokeOpacity="0.8" />
        <path d={pathFor("portfolioValue")} fill="none" stroke="#22d3ee" strokeWidth="2.4" />

        {hoverIdx !== null && (
          <line
            x1={xOf(hoverIdx)}
            x2={xOf(hoverIdx)}
            y1={pad.top}
            y2={h - pad.bottom}
            stroke="#475569"
            strokeDasharray="2 2"
          />
        )}

        <text x={pad.left} y={h - 6} className="fill-slate-500 text-[10px] font-mono">
          {points[0].date}
        </text>
        <text x={w - pad.right} y={h - 6} textAnchor="end" className="fill-slate-500 text-[10px] font-mono">
          {points[points.length - 1].date}
        </text>
      </svg>
    </div>
  );
}

export function OrderbookDepthLadder({ book }: { book: OrderbookSnapshot | null }) {
  if (!book) {
    return (
      <div className="p-4 text-xs text-slate-500 border border-slate-800 rounded-xl bg-slate-950/60">
        Select a Spot or Perps pair to stream live L2 depth.
      </div>
    );
  }

  const asks = [...book.asks.slice(0, 8)].reverse();
  const bids = book.bids.slice(0, 8);
  const maxCum = Math.max(
    asks[0]?.cumNotionalUsd ?? 1,
    bids[bids.length - 1]?.cumNotionalUsd ?? 1,
    1
  );

  return (
    <div className="bg-slate-950/70 border border-slate-800/90 rounded-xl p-3.5 text-xs font-mono">
      <div className="flex items-center justify-between mb-2 pb-2 border-b border-slate-800/80">
        <span className="font-semibold text-slate-200">{book.symbol} L2 Book</span>
        <span className="text-[11px] text-slate-400">
          Spread <strong className="text-cyan-300">{book.spreadBps.toFixed(1)} bps</strong>
        </span>
      </div>
      <div className="grid grid-cols-3 text-[10px] uppercase text-slate-500 pb-1">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Cum $</span>
      </div>
      <div className="space-y-0.5">
        {asks.map((lvl, i) => (
          <div key={`a-${i}`} className="relative grid grid-cols-3 py-0.5 px-1 rounded overflow-hidden">
            <div
              className="absolute inset-y-0 right-0 bg-rose-500/15"
              style={{ width: `${Math.min(100, (lvl.cumNotionalUsd / maxCum) * 100)}%` }}
            />
            <span className="relative text-rose-400">{lvl.price.toFixed(4)}</span>
            <span className="relative text-right text-slate-300">{lvl.size.toFixed(2)}</span>
            <span className="relative text-right text-slate-400">${lvl.cumNotionalUsd.toFixed(0)}</span>
          </div>
        ))}
      </div>
      <div className="my-1.5 py-1 px-2 rounded bg-slate-900/90 border border-slate-800 flex justify-between text-[11px]">
        <span className="text-slate-400">Mid ${book.midPrice.toFixed(4)}</span>
        <span className={book.imbalanceRatio >= 0 ? "text-emerald-400" : "text-rose-400"}>
          Imb {(book.imbalanceRatio * 100).toFixed(1)}%
        </span>
      </div>
      <div className="space-y-0.5">
        {bids.map((lvl, i) => (
          <div key={`b-${i}`} className="relative grid grid-cols-3 py-0.5 px-1 rounded overflow-hidden">
            <div
              className="absolute inset-y-0 right-0 bg-emerald-500/15"
              style={{ width: `${Math.min(100, (lvl.cumNotionalUsd / maxCum) * 100)}%` }}
            />
            <span className="relative text-emerald-400">{lvl.price.toFixed(4)}</span>
            <span className="relative text-right text-slate-300">{lvl.size.toFixed(2)}</span>
            <span className="relative text-right text-slate-400">${lvl.cumNotionalUsd.toFixed(0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
