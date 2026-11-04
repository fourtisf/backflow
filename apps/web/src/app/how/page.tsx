import { BRAND, COMPARE, COPY, FEE_SEGMENTS, RATES, solExact, supplyWords, tradeFees } from "@backflow/core";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Icon, type IconName } from "@/components/Icon";

export const metadata = { title: "How it works" };

/** Every number on this page comes from config/fees.json (through @backflow/core), never typed in. */
const ONE_SOL = 1_000_000_000n;
const FX = tradeFees(ONE_SOL);
const EX_SOL = solExact(ONE_SOL);
const TH = COPY.buybackThresholdSol;
const EVERY = COPY.payoutEvery === "minute" ? "every minute" : `every ${COPY.payoutEvery}`;
const PER_TRADE: Record<string, bigint> = { hold: FX.holdersPart, plat: FX.platformPart, crea: FX.creator, ray: FX.protocol };

const SEG: Record<string, { col: string; icon: IconName; who: string; text: string }> = {
  hold: { col: "#45E3D3", icon: "users", who: "Back to holders", text: `Fills the coin's vault. Every ${TH} SOL becomes a buyback, split across holders by how much they hold.` },
  plat: { col: "#8F9CFF", icon: "server", who: `Runs ${BRAND.name}`, text: "The payout bot, servers and the team that keeps it running." },
  crea: { col: "#FF8DB3", icon: "spark", who: "To the creator", text: "Sent by Raydium straight to the wallet that launched the coin. Claim it any time." },
  ray: { col: "#7C8BC9", icon: "layers", who: "To Raydium", text: "LaunchLab's protocol fee for running the bonding curve." },
};

/** Split ring: one arc per fee share, drawn in on load (static with reduced motion). */
function SplitRing() {
  const r = 84;
  const c = 2 * Math.PI * r;
  const total = Number(RATES.totalPpm);
  const gap = 5;
  let offset = 0;
  return (
    <svg className="hw-ring" viewBox="0 0 220 220" role="img" aria-label={`Fee split: ${FEE_SEGMENTS.map((s) => `${s.label} ${s.pct}`).join(", ")}`}>
      <defs>
        <filter id="hwGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle cx="110" cy="110" r={r} fill="none" stroke="rgba(143,156,255,.10)" strokeWidth="18" />
      {FEE_SEGMENTS.map((s, i) => {
        const len = (Number(s.ppm) / total) * c - gap;
        const el = (
          <circle
            key={s.key}
            className="hw-arc"
            cx="110"
            cy="110"
            r={r}
            fill="none"
            stroke={SEG[s.key]!.col}
            strokeWidth="18"
            strokeLinecap="round"
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 110 110)"
            filter={s.key === "hold" ? "url(#hwGlow)" : undefined}
            style={{ "--d": `${i * 0.12}s`, "--len": len, "--rest": c - len, "--c": c } as CSSProperties}
          />
        );
        offset += len + gap;
        return el;
      })}
    </svg>
  );
}

export default function HowPage() {
  const cmpMax = Number(COMPARE.curveFeePpm > RATES.totalPpm ? COMPARE.curveFeePpm : RATES.totalPpm);
  const holdShare = Number(RATES.holdersPpm) / Number(RATES.totalPpm);
  return (
    <div className="wrap hw">
      {/* ---------------------------------- hero ---------------------------------- */}
      <section className="hw-hero">
        <div className="hw-hero-copy">
          <span className="hw-eyebrow">
            <i />
            The {BRAND.name} fee
          </span>
          <h1>
            One small fee.
            <br />
            <span className="hw-grad">Most of it comes back.</span>
          </h1>
          <p>
            Every buy and sell pays the same {COPY.total}. {COPY.holders} of it buys the coin back for the people holding it, automatically and on chain.
          </p>
          <div className="hw-hero-stats">
            <div>
              <b className="num">{COPY.total}</b>
              <span>per trade, buy or sell</span>
            </div>
            <div>
              <b className="num hw-teal">{COPY.holders}</b>
              <span>back to holders</span>
            </div>
            <div>
              <b className="num">{COPY.compareTotal}</b>
              <span>on {COMPARE.name}, nothing back</span>
            </div>
          </div>
        </div>
        <div className="hw-ring-wrap">
          <SplitRing />
          <div className="hw-ring-center">
            <span className="num">{COPY.total}</span>
            <small>of every trade</small>
          </div>
        </div>
      </section>

      {/* --------------------------------- split --------------------------------- */}
      <section className="hw-sec" aria-labelledby="hw-split">
        <div className="hw-head">
          <h2 id="hw-split">Where the {COPY.total} goes</h2>
          <p>
            On a {EX_SOL} SOL trade the fee is {solExact(FX.total)} SOL. This is exactly how it splits.
          </p>
        </div>
        <div className="hw-cards">
          {FEE_SEGMENTS.map((s) => {
            const m = SEG[s.key]!;
            return (
              <article key={s.key} className={`hw-card${s.key === "hold" ? " is-hold" : ""}`} style={{ "--c": m.col } as CSSProperties}>
                <div className="hw-card-top">
                  <span className="hw-ic" aria-hidden="true">
                    <Icon name={m.icon} size={18} />
                  </span>
                  <span className="hw-who">{m.who}</span>
                </div>
                <div className="hw-pct num">{s.pct}</div>
                <div className="hw-amt num">
                  {solExact(PER_TRADE[s.key]!)} SOL <span>per {EX_SOL} SOL trade</span>
                </div>
                <p>{m.text}</p>
                <div className="hw-meter" aria-hidden="true">
                  <span style={{ width: `${(Number(s.ppm) / Number(RATES.totalPpm)) * 100}%` }} />
                </div>
              </article>
            );
          })}
        </div>

        <div className="hw-compare">
          <div className="hw-cmp-row">
            <span className="hw-cmp-name">{BRAND.name}</span>
            <div className="hw-cmp-track">
              <div className="hw-cmp-bar" style={{ width: `${(Number(RATES.totalPpm) / cmpMax) * 100}%` }}>
                <span className="hw-cmp-hold" style={{ width: `${holdShare * 100}%` }} />
              </div>
            </div>
            <span className="hw-cmp-val num">{COPY.total}</span>
          </div>
          <div className="hw-cmp-row">
            <span className="hw-cmp-name">{COMPARE.name}</span>
            <div className="hw-cmp-track">
              <div className="hw-cmp-bar is-other" style={{ width: `${(Number(COMPARE.curveFeePpm) / cmpMax) * 100}%` }} />
            </div>
            <span className="hw-cmp-val num">{COPY.compareTotal}</span>
          </div>
          <p className="hw-cmp-note">
            <span className="hw-dot" /> You pay less than on {COMPARE.name}&apos;s bonding curve, and {COPY.holders} of every trade comes back to holders.
          </p>
        </div>
      </section>

      {/* ---------------------------------- flow ---------------------------------- */}
      <section className="hw-sec" aria-labelledby="hw-flow">
        <div className="hw-head">
          <h2 id="hw-flow">One trade, start to finish</h2>
          <p>
            Someone buys {EX_SOL} SOL of $MOCHI. Here is what happens to the {solExact(FX.total)} SOL fee.
          </p>
        </div>
        <ol className="hw-steps">
          <li>
            <span className="hw-node">1</span>
            <h4>Trade</h4>
            <p>
              A {EX_SOL} SOL buy pays {solExact(FX.total)} SOL in fees.
            </p>
            <span className="hw-chip num">{COPY.total} fee</span>
          </li>
          <li>
            <span className="hw-node">2</span>
            <h4>Coin vault</h4>
            <p>The holders&apos; share lands in this coin&apos;s vault.</p>
            <span className="hw-chip num">+{solExact(FX.holdersPart)} SOL</span>
          </li>
          <li>
            <span className="hw-node">3</span>
            <h4>Buyback</h4>
            <p>
              At {TH} SOL the bot buys $MOCHI, never moving the price more than {COPY.maxImpact}.
            </p>
            <span className="hw-chip num">at {TH} SOL</span>
          </li>
          <li>
            <span className="hw-node">4</span>
            <h4>Holders</h4>
            <p>Bought coins are split pro rata and paid to every holder&apos;s wallet.</p>
            <span className="hw-chip">{EVERY}</span>
          </li>
        </ol>
        <p className="hw-callout">
          <Icon name="info" size={16} />
          Sold before the payout? Your pending coins go back to the holders who stayed.
        </p>
      </section>

      {/* ---------------------------------- life ---------------------------------- */}
      <section className="hw-sec" aria-labelledby="hw-life">
        <div className="hw-head">
          <h2 id="hw-life">The life of a coin</h2>
          <p>Buybacks start with the first trade and never stop, before and after graduation.</p>
        </div>
        <ol className="hw-life">
          <li>
            <span className="hw-phase">Day one</span>
            <h4>Launch</h4>
            <p>The coin starts on a Raydium LaunchLab bonding curve. Supply is {supplyWords()}. The creator can make a first buy in the same transaction.</p>
          </li>
          <li>
            <span className="hw-phase">First trade</span>
            <h4>Buybacks start</h4>
            <p>
              {COPY.holders} of every buy and sell fills the vault. Each full {TH === "1" ? "SOL" : `${TH} SOL`} becomes a buyback paid to holders.
            </p>
          </li>
          <li>
            <span className="hw-phase num">{COPY.graduationSol} SOL</span>
            <h4>Graduation</h4>
            <p>The coin moves to a Raydium pool. Liquidity is locked forever and can&apos;t be pulled.</p>
          </li>
          <li>
            <span className="hw-phase">Forever</span>
            <h4>After graduation</h4>
            <p>Fees from the locked pool keep feeding the vault, so buybacks for holders never stop.</p>
          </li>
        </ol>
      </section>

      {/* ---------------------------------- rules --------------------------------- */}
      <section className="hw-sec" aria-labelledby="hw-rules">
        <div className="hw-head">
          <h2 id="hw-rules">Rules that keep it fair</h2>
        </div>
        <div className="hw-rules">
          <div className="hw-rule">
            <span className="hw-ic" aria-hidden="true">
              <Icon name="clock" size={18} />
            </span>
            <div>
              <h4>Payouts every {COPY.payoutEvery}</h4>
              <p>Bought-back coins wait in your pending balance and land in your wallet at the next payout.</p>
            </div>
          </div>
          <div className="hw-rule">
            <span className="hw-ic" aria-hidden="true">
              <Icon name="warn" size={18} />
            </span>
            <div>
              <h4>Sell early, forfeit pending</h4>
              <p>If you sell before a payout, what you were owed goes back to the holders who stayed.</p>
            </div>
          </div>
          <div className="hw-rule">
            <span className="hw-ic" aria-hidden="true">
              <Icon name="shield" size={18} />
            </span>
            <div>
              <h4>Small, steady buybacks</h4>
              <p>
                Each buyback is {TH} SOL and can&apos;t move the price more than {COPY.maxImpact}, so bots can&apos;t farm it.
              </p>
            </div>
          </div>
          <div className="hw-rule">
            <span className="hw-ic" aria-hidden="true">
              <Icon name="ban" size={18} />
            </span>
            <div>
              <h4>Pools don&apos;t earn</h4>
              <p>The bonding curve vault, the Raydium pool and platform wallets are left out of every payout.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------- cta ---------------------------------- */}
      <section className="hw-cta">
        <div>
          <h2>Launch a coin that pays its holders.</h2>
          <p>No launch fee. Buybacks start with the first trade.</p>
        </div>
        <div className="hw-cta-btns">
          <Link className="btn btn-primary btn-lg" href="/launch">
            Launch a coin
            <Icon name="arrow" size={16} />
          </Link>
          <Link className="btn btn-ghost btn-lg" href="/">
            Explore coins
          </Link>
        </div>
      </section>
    </div>
  );
}
