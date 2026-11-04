import { BRAND, COMPARE, COPY, FEE_SEGMENTS, exampleTrade, solExact, supplyWords } from "@backflow/core";
import { Icon } from "@/components/Icon";

export const metadata = { title: "How it works" };

const F = { fontFamily: "Geist,system-ui,sans-serif" };
const EX = exampleTrade();
const EX_SOL = solExact(EX.amount);
const EX_FEE = solExact(EX.totalFee);
const EX_HOLD = solExact(EX.holders);
const TH = COPY.buybackThresholdSol;
const EVERY = COPY.payoutEvery === "minute" ? "each minute" : `every ${COPY.payoutEvery}`;

function Box({ x, y, w, t1, t2, col }: { x: number; y: number; w: number; t1: string; t2: string; col: string }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect width={w} height="76" rx="16" fill="#131E42" stroke={col} strokeOpacity=".55" />
      <text x={w / 2} y="33" textAnchor="middle" fill="#E9EEFF" style={F} fontSize="15" fontWeight="600">
        {t1}
      </text>
      <text x={w / 2} y="54" textAnchor="middle" fill="#8E9AC6" style={F} fontSize="12.5">
        {t2}
      </text>
    </g>
  );
}
function Arr({ x1, x2, y, label }: { x1: number; x2: number; y: number; label?: string }) {
  return (
    <>
      <path d={`M${x1} ${y}H${x2 - 8}`} stroke="#45E3D3" strokeWidth="2" strokeDasharray="5 5" />
      <path d={`M${x2 - 9} ${y - 5}l7 5-7 5`} fill="none" stroke="#45E3D3" strokeWidth="2" />
      {label && (
        <text x={(x1 + x2) / 2} y={y - 10} textAnchor="middle" fill="#8E9AC6" style={F} fontSize="12">
          {label}
        </text>
      )}
    </>
  );
}
function FlowH() {
  return (
    <svg className="fh" viewBox="0 0 1100 190" role="img" aria-label="Trade fee flows to the vault, then a buyback, then holders">
      <Box x={0} y={40} w={190} t1="Trade" t2={`${EX_SOL} SOL buy, ${COPY.total} fee`} col="#8F9CFF" />
      <Arr x1={190} x2={290} y={78} label={`${EX_HOLD} SOL`} />
      <Box x={290} y={40} w={200} t1="Coin vault" t2={`fills to ${TH} SOL`} col="#45E3D3" />
      <Arr x1={490} x2={590} y={78} label={`at ${TH} SOL`} />
      <Box x={590} y={40} w={200} t1="Buyback" t2={`buys $MOCHI, max ${COPY.maxImpact} impact`} col="#45E3D3" />
      <Arr x1={790} x2={890} y={78} label="pro-rata" />
      <Box x={890} y={40} w={210} t1="Holders" t2={`paid in $MOCHI ${EVERY}`} col="#45E3D3" />
      <path d="M995 120v34H395v-38" fill="none" stroke="#8F9CFF" strokeOpacity=".45" strokeWidth="2" strokeDasharray="4 6" />
      <text x="695" y="176" textAnchor="middle" fill="#6A77A6" style={F} fontSize="12">
        Sold before payout? Pending coins go back to holders who stayed.
      </text>
    </svg>
  );
}
function VBox({ y, t1, t2, col }: { y: number; t1: string; t2: string; col: string }) {
  return (
    <g transform={`translate(20,${y})`}>
      <rect width="300" height="62" rx="14" fill="#131E42" stroke={col} strokeOpacity=".55" />
      <text x="150" y="27" textAnchor="middle" fill="#E9EEFF" style={F} fontSize="15" fontWeight="600">
        {t1}
      </text>
      <text x="150" y="46" textAnchor="middle" fill="#8E9AC6" style={F} fontSize="12.5">
        {t2}
      </text>
    </g>
  );
}
function VArr({ y1, y2, label }: { y1: number; y2: number; label: string }) {
  return (
    <>
      <path d={`M170 ${y1}V${y2 - 8}`} stroke="#45E3D3" strokeWidth="2" strokeDasharray="5 5" />
      <path d={`M165 ${y2 - 9}l5 7 5-7`} fill="none" stroke="#45E3D3" strokeWidth="2" />
      <text x="184" y={(y1 + y2) / 2 + 4} fill="#8E9AC6" style={F} fontSize="12">
        {label}
      </text>
    </>
  );
}
function FlowV() {
  return (
    <svg className="fv" viewBox="0 0 340 440" role="img" aria-label="Trade fee flows to the vault, then a buyback, then holders">
      <VBox y={0} t1="Trade" t2={`${EX_SOL} SOL buy, ${COPY.total} fee`} col="#8F9CFF" />
      <VArr y1={62} y2={110} label={`${EX_HOLD} SOL`} />
      <VBox y={110} t1="Coin vault" t2={`fills to ${TH} SOL`} col="#45E3D3" />
      <VArr y1={172} y2={220} label={`at ${TH} SOL`} />
      <VBox y={220} t1="Buyback" t2={`buys $MOCHI, max ${COPY.maxImpact} impact`} col="#45E3D3" />
      <VArr y1={282} y2={330} label="pro-rata" />
      <VBox y={330} t1="Holders" t2={`paid in $MOCHI ${EVERY}`} col="#45E3D3" />
      <text x="170" y="418" textAnchor="middle" fill="#6A77A6" style={F} fontSize="12">
        Sold before payout? Pending coins go
      </text>
      <text x="170" y="434" textAnchor="middle" fill="#6A77A6" style={F} fontSize="12">
        back to holders who stayed.
      </text>
    </svg>
  );
}

const SPLIT_COPY: Record<string, { col: string; text: string }> = {
  hold: { col: "var(--current)", text: `Collected in the coin's vault. At ${TH} SOL the bot buys the coin and splits it across holders by balance.` },
  plat: { col: "var(--peri)", text: `Runs ${BRAND.name}: the payout bot, servers and the team.` },
  crea: { col: "var(--rose)", text: "Paid by Raydium directly to the wallet that launched the coin. Claimable anytime." },
  ray: { col: "var(--slate)", text: "Raydium LaunchLab's protocol fee for running the bonding curve." },
};

export default function HowPage() {
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Where the {COPY.total} goes</h1>
        <p>Every buy and sell on {BRAND.name} pays the same {COPY.total} fee. Most of it comes back to the people holding the coin.</p>
      </div>
      <section className="how-sec">
        <div className="panel bigsplit">
          <div className="fbar" role="img" aria-label="Fee split">
            {FEE_SEGMENTS.map((s) => (
              <span key={s.key} className={`c-${s.key}`} style={{ flex: Number(s.ppm) }}>
                {s.pct}
              </span>
            ))}
          </div>
          <div className="split-rows">
            {FEE_SEGMENTS.map((s) => (
              <div key={s.key} style={{ borderColor: SPLIT_COPY[s.key]!.col }}>
                <div className="k">{s.label}</div>
                <div className="v num">{s.pct}</div>
                <p>{SPLIT_COPY[s.key]!.text}</p>
              </div>
            ))}
          </div>
          <div className="cmp">
            <span className="tag">{COPY.total} total</span>
            <span>
              Lower than the {COPY.compareTotal} you pay on {COMPARE.name}&apos;s bonding curve, and holders get a cut.
            </span>
          </div>
        </div>
      </section>

      <section className="how-sec">
        <h2>One trade, start to finish</h2>
        <p>
          Someone buys {EX_SOL} SOL of $MOCHI. Here is what happens to the {EX_FEE} SOL fee.
        </p>
        <div className="panel flow">
          <FlowH />
          <FlowV />
        </div>
      </section>

      <section className="how-sec">
        <h2>The life of a coin</h2>
        <ol className="life">
          <li className="panel">
            <h4>Launch</h4>
            <p>The coin starts on a Raydium LaunchLab bonding curve. Supply is {supplyWords()}. The creator can make a first buy in the same transaction.</p>
          </li>
          <li className="panel">
            <h4>Buybacks start</h4>
            <p>
              From the first trade, {COPY.holders} of every buy and sell fills the vault. Each full {TH === "1" ? "SOL" : `${TH} SOL`} becomes a buyback paid to holders.
            </p>
          </li>
          <li className="panel">
            <h4>Graduation</h4>
            <p>At {COPY.graduationSol} SOL in the curve, the coin moves to a Raydium pool. Liquidity is locked forever and can&apos;t be pulled.</p>
          </li>
          <li className="panel">
            <h4>After graduation</h4>
            <p>Fees from the locked pool keep feeding the vault, so buybacks for holders never stop.</p>
          </li>
        </ol>
      </section>

      <section className="how-sec">
        <h2>Rules that keep it fair</h2>
        <div className="rules">
          <div className="panel">
            <span className="ic">
              <Icon name="clock" />
            </span>
            <div>
              <h4>Payouts every {COPY.payoutEvery}</h4>
              <p>Bought-back coins wait in your pending balance and land in your wallet at the next payout.</p>
            </div>
          </div>
          <div className="panel">
            <span className="ic">
              <Icon name="warn" />
            </span>
            <div>
              <h4>Sell early, forfeit pending</h4>
              <p>If you sell before a payout, what you were owed goes back to the holders who stayed.</p>
            </div>
          </div>
          <div className="panel">
            <span className="ic">
              <Icon name="shield" />
            </span>
            <div>
              <h4>Small, steady buybacks</h4>
              <p>
                Each buyback is {TH} SOL and can&apos;t move the price more than {COPY.maxImpact}, so bots can&apos;t farm it.
              </p>
            </div>
          </div>
          <div className="panel">
            <span className="ic">
              <Icon name="ban" />
            </span>
            <div>
              <h4>Pools don&apos;t earn</h4>
              <p>The bonding curve vault, the Raydium pool and platform wallets are left out of every payout.</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
