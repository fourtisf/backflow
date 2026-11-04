"use client";

/** Market-cap candlestick chart with buyback markers, ported from the prototype's drawChart(). */
import { pct, usd, type CandleDTO } from "@backflow/core";
import { useCallback, useEffect, useRef, useState } from "react";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function CandleChart({ candles, label, controls, empty }: { candles: CandleDTO[]; label: string; controls?: React.ReactNode; empty?: React.ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hoverX = useRef<number | null>(null);
  const [hover, setHover] = useState<CandleDTO | null>(null);

  const draw = useCallback(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!candles.length) return;
    const padR = 64;
    const padL = 10;
    const padT = 12;
    const padB = 22;
    const pw = W - padL - padR;
    const ph = H - padT - padB;
    const n = Math.max(20, Math.min(candles.length, Math.floor(pw / 9)));
    const d = candles.slice(-n);
    let lo = Math.min(...d.map((x) => x.l));
    let hi = Math.max(...d.map((x) => x.h));
    const pad = (hi - lo) * 0.12 || hi * 0.05;
    lo -= pad;
    hi += pad;
    const y = (v: number) => padT + ph - ((v - lo) / (hi - lo)) * ph;
    const step = pw / Math.max(d.length, 40);
    const cw = Math.max(2, step * 0.62);
    g.font = "11.5px Geist, system-ui, sans-serif";
    g.textBaseline = "middle";
    g.textAlign = "left";
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      const yy = y(v);
      g.strokeStyle = "rgba(143,160,230,.08)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(padL, Math.round(yy) + 0.5);
      g.lineTo(padL + pw, Math.round(yy) + 0.5);
      g.stroke();
      g.fillStyle = "#6A77A6";
      g.fillText(usd(v), padL + pw + 10, yy);
    }
    const grad = g.createLinearGradient(0, padT, 0, padT + ph);
    grad.addColorStop(0, "rgba(69,227,211,.10)");
    grad.addColorStop(1, "rgba(69,227,211,0)");
    g.beginPath();
    d.forEach((x, i) => {
      const xx = padL + i * step + step / 2;
      if (i) g.lineTo(xx, y(x.c));
      else g.moveTo(xx, y(x.c));
    });
    g.lineTo(padL + (d.length - 0.5) * step, padT + ph);
    g.lineTo(padL + step / 2, padT + ph);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    d.forEach((x, i) => {
      const xx = padL + i * step + step / 2;
      const up = x.c >= x.o;
      const col = up ? "#3DDC97" : "#FF5C7A";
      g.strokeStyle = col;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(xx) + 0.5, y(x.h));
      g.lineTo(Math.round(xx) + 0.5, y(x.l));
      g.stroke();
      const top = y(Math.max(x.o, x.c));
      const bot = y(Math.min(x.o, x.c));
      g.fillStyle = col;
      g.fillRect(xx - cw / 2, top, cw, Math.max(1.2, bot - top));
      if (x.buyback) {
        const my = Math.min(padT + ph - 3, y(x.l) + 8);
        g.beginPath();
        g.arc(xx, my, 3, 0, Math.PI * 2);
        g.fillStyle = "#45E3D3";
        g.fill();
        g.beginPath();
        g.arc(xx, my, 6, 0, Math.PI * 2);
        g.fillStyle = "rgba(69,227,211,.18)";
        g.fill();
      }
    });
    const last = d[d.length - 1]!;
    const ly = y(last.c);
    g.setLineDash([3, 4]);
    g.strokeStyle = "rgba(69,227,211,.55)";
    g.beginPath();
    g.moveTo(padL, ly);
    g.lineTo(padL + pw, ly);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = "#45E3D3";
    const lbl = usd(last.c);
    const tw = g.measureText(lbl).width + 12;
    g.beginPath();
    if (g.roundRect) g.roundRect(padL + pw + 4, ly - 10, tw, 20, 6);
    else g.rect(padL + pw + 4, ly - 10, tw, 20);
    g.fill();
    g.fillStyle = "#04201E";
    g.fillText(lbl, padL + pw + 10, ly);
    const hx = hoverX.current;
    if (hx != null && hx > padL && hx < padL + pw) {
      const i = clamp(Math.floor((hx - padL) / step), 0, d.length - 1);
      const xx = padL + i * step + step / 2;
      g.strokeStyle = "rgba(233,238,255,.25)";
      g.beginPath();
      g.moveTo(Math.round(xx) + 0.5, padT);
      g.lineTo(Math.round(xx) + 0.5, padT + ph);
      g.stroke();
      setHover(d[i] ?? null);
    } else setHover(null);
  }, [candles]);

  useEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const ch = hover ? (hover.c / hover.o - 1) * 100 : 0;
  return (
    <>
      <div className="chart-head">
        <div className="hov">
          <HoverLine hover={hover} ch={ch} />
        </div>
        {controls}
      </div>
      <div className="chart-wrap">
        {empty ? <div className="empty" style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center" }}>{empty}</div> : null}
        <canvas
          ref={ref}
          role="img"
          aria-label={label}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            hoverX.current = e.clientX - r.left;
            draw();
          }}
          onMouseLeave={() => {
            hoverX.current = null;
            draw();
          }}
          onTouchMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const t = e.touches[0];
            if (!t) return;
            hoverX.current = t.clientX - r.left;
            draw();
          }}
          onTouchEnd={() => {
            hoverX.current = null;
            draw();
          }}
        />
      </div>
    </>
  );
}

function HoverLine({ hover, ch }: { hover: CandleDTO | null; ch: number }) {
  return (
    <>
      {hover ? (
        <>
          Open <b className="num">{usd(hover.o)}</b>&nbsp; Close <b className="num">{usd(hover.c)}</b>&nbsp; <span className={`${ch >= 0 ? "up" : "down"} num`}>{pct(ch)}</span>
          {hover.buyback ? (
            <>
              &nbsp; <span style={{ color: "var(--current)" }}>Buyback in this candle</span>
            </>
          ) : null}
        </>
      ) : (
        "Market cap"
      )}
    </>
  );
}
