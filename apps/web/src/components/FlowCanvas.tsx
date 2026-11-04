"use client";

/**
 * Hero particle ring: the "Flow" engine from prototype/backflow.html as a
 * client component. Shows a coin's vault progress toward the next buyback;
 * on each real buyback for that coin the ring contracts and bursts outward.
 * With prefers-reduced-motion it draws a static frame and redraws only when
 * the value changes.
 */
import { useEffect, useRef } from "react";
import { onLive } from "@/lib/store";

const TAU = Math.PI * 2;

interface Part {
  a: number;
  dr: number;
  w: number;
  s: number;
  ph: number;
  k: number;
}
interface SparkP {
  a: number;
  sp: number;
  d: number;
  life: number;
  delay: number;
  len: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

class FlowEngine {
  private g: CanvasRenderingContext2D;
  private raf = 0;
  private parts: Part[] = [];
  private sparks: SparkP[] = [];
  private b = -1;
  private p: number;
  private last = 0;
  target: number;

  constructor(
    private cv: HTMLCanvasElement,
    initial: number,
    private reduced: boolean,
  ) {
    this.g = cv.getContext("2d")!;
    this.target = clamp(initial, 0, 1);
    this.p = this.target;
    // Seeded so the static (reduced-motion) frame is stable between renders.
    let seed = 20261104;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 1700; i++) {
      const u = rnd() || 1e-6;
      const v = rnd();
      const gs = Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
      this.parts.push({ a: rnd() * TAU, dr: gs * 0.06, w: 0.0011 + rnd() * 0.0034, s: 0.9 + rnd() * 1.9, ph: rnd() * TAU, k: rnd() });
    }
  }

  start() {
    this.last = performance.now();
    if (this.reduced) {
      this.frame(this.last);
      return;
    }
    const loop = (t: number) => {
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setTarget(v: number) {
    this.target = clamp(v, 0, 1);
    if (this.reduced) {
      this.p = this.target;
      this.frame(performance.now());
    }
  }

  redraw() {
    this.frame(performance.now());
  }

  burst() {
    if (this.reduced) return;
    this.b = 0;
    for (let i = 0; i < 90; i++) this.sparks.push({ a: Math.random() * TAU, sp: 2 + Math.random() * 4.5, d: 0, life: 1, delay: 0.24 + Math.random() * 0.12, len: 6 + Math.random() * 12 });
  }

  private frame(t: number) {
    const { cv, g } = this;
    const dt = Math.min(50, Math.max(0, t - this.last));
    this.last = t;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.37;
    const target = this.target;
    if (target < this.p - 0.25) this.p = target;
    else this.p += (target - this.p) * Math.min(1, dt / 350);
    let scale = 1;
    let spin = 1;
    if (this.b >= 0) {
      this.b += dt / 1700;
      const b = this.b;
      if (b < 0.24) {
        const e = b / 0.24;
        scale = 1 - 0.74 * e * e;
        spin = 1 + 7 * e;
      } else if (b < 1) {
        const e = (b - 0.24) / 0.76;
        const c1 = 1.70158;
        const c3 = c1 + 1;
        scale = 0.26 + 0.74 * (1 + c3 * Math.pow(e - 1, 3) + c1 * Math.pow(e - 1, 2));
        spin = 1 + 7 * (1 - e);
      } else this.b = -1;
    }
    // glow
    const rg = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.55);
    rg.addColorStop(0, "rgba(69,227,211,.13)");
    rg.addColorStop(0.45, "rgba(118,130,255,.07)");
    rg.addColorStop(1, "rgba(5,8,23,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
    // guide rings
    g.lineWidth = 1;
    g.strokeStyle = "rgba(160,176,255,.08)";
    g.beginPath();
    g.arc(cx, cy, R * scale, 0, TAU);
    g.stroke();
    g.setLineDash([2, 7]);
    g.strokeStyle = "rgba(160,176,255,.10)";
    g.beginPath();
    g.arc(cx, cy, R * 1.24, 0, TAU);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, R * 0.62, 0, TAU);
    g.stroke();
    g.setLineDash([]);
    // particles
    const P = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const time = t * 0.001;
    const prog = this.p;
    for (const q of this.parts) {
      if (!this.reduced) q.a += (q.w * spin * dt) / 16;
      const a = q.a % TAU;
      const r = (R * (1 + q.dr) + Math.sin(a * 3 + time * 0.7 + q.ph) * R * 0.028) * scale;
      const x = cx + Math.sin(a) * r;
      const y = cy - Math.cos(a) * r;
      const bi = (a / TAU < prog ? 0 : 2) + (q.k > 0.55 ? 0 : 1);
      P[bi]!.rect(x, y, q.s, q.s);
    }
    g.globalCompositeOperation = "lighter";
    g.lineWidth = R * 0.16;
    g.strokeStyle = "rgba(143,156,255,.05)";
    g.beginPath();
    g.arc(cx, cy, R * scale, 0, TAU);
    g.stroke();
    if (prog > 0.005) {
      g.lineCap = "butt";
      g.lineWidth = R * 0.14;
      g.strokeStyle = "rgba(69,227,211,.09)";
      g.beginPath();
      g.arc(cx, cy, R * scale, -Math.PI / 2, -Math.PI / 2 + TAU * prog);
      g.stroke();
    }
    g.fillStyle = "rgba(110,240,225,.95)";
    g.fill(P[0]!);
    g.fillStyle = "rgba(116,185,255,.62)";
    g.fill(P[1]!);
    g.fillStyle = "rgba(160,170,255,.42)";
    g.fill(P[2]!);
    g.fillStyle = "rgba(143,156,255,.22)";
    g.fill(P[3]!);
    // progress arc + head
    if (prog > 0.005) {
      const r0 = R * scale;
      const a0 = -Math.PI / 2;
      const a1 = a0 + TAU * prog;
      g.lineCap = "round";
      g.lineWidth = 2.4;
      g.strokeStyle = "rgba(69,227,211,.55)";
      g.beginPath();
      g.arc(cx, cy, r0, a0, a1);
      g.stroke();
      const hx = cx + Math.cos(a1) * r0;
      const hy = cy + Math.sin(a1) * r0;
      const hg = g.createRadialGradient(hx, hy, 0, hx, hy, 22);
      hg.addColorStop(0, "rgba(220,255,250,.95)");
      hg.addColorStop(0.25, "rgba(69,227,211,.55)");
      hg.addColorStop(1, "rgba(69,227,211,0)");
      g.fillStyle = hg;
      g.beginPath();
      g.arc(hx, hy, 22, 0, TAU);
      g.fill();
    }
    // burst flash + sparks
    if (this.b >= 0 && this.b < 0.5) {
      const f = 1 - Math.abs(this.b - 0.26) / 0.26;
      if (f > 0) {
        const fg = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.9);
        fg.addColorStop(0, `rgba(220,255,250,${0.55 * f})`);
        fg.addColorStop(1, "rgba(69,227,211,0)");
        g.fillStyle = fg;
        g.beginPath();
        g.arc(cx, cy, R * 0.9, 0, TAU);
        g.fill();
      }
    }
    if (this.sparks.length) {
      g.lineWidth = 1.6;
      g.lineCap = "round";
      const bnow = this.b < 0 ? 2 : this.b;
      this.sparks = this.sparks.filter((sp) => {
        if (bnow < sp.delay) return true;
        sp.d += (sp.sp * dt) / 16;
        sp.life -= dt / 1300;
        if (sp.life <= 0) return false;
        const r1 = R * 0.18 + sp.d;
        const r2 = r1 + sp.len;
        g.strokeStyle = `rgba(120,240,228,${(sp.life * 0.9).toFixed(3)})`;
        g.beginPath();
        g.moveTo(cx + Math.sin(sp.a) * r1, cy - Math.cos(sp.a) * r1);
        g.lineTo(cx + Math.sin(sp.a) * r2, cy - Math.cos(sp.a) * r2);
        g.stroke();
        return true;
      });
    }
    g.globalCompositeOperation = "source-over";
  }
}

export function FlowCanvas({ mint, value }: { mint: string | null; value: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const eng = useRef<FlowEngine | null>(null);
  const mintRef = useRef(mint);
  mintRef.current = mint;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const e = new FlowEngine(cv, value, reduced);
    eng.current = e;
    e.start();
    const off = onLive((ev) => {
      if (ev.type === "buyback" && ev.buyback.coinMint === mintRef.current) e.burst();
    });
    const onResize = () => e.redraw();
    window.addEventListener("resize", onResize);
    return () => {
      off();
      window.removeEventListener("resize", onResize);
      e.stop();
      eng.current = null;
    };
    // value is pushed through setTarget below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    eng.current?.setTarget(value);
  }, [value]);

  return <canvas ref={ref} aria-hidden="true" />;
}
