# Backflow — build brief for Claude Code

Paste everything below the line into Claude Code, opened in an empty project folder that contains this handoff package.

---

You are building **Backflow**, a Solana memecoin launchpad on top of **Raydium LaunchLab**. Its one idea: every trade pays a 1.1% fee, and 0.45% of every trade is used to **buy the coin back on the open market and pay those tokens to the people holding it**.

Read these files in this order before writing any code:

1. `CLAUDE.md`: project rules, stack, and safety limits. Follow them for the whole project.
2. `docs/SPEC.md`: the full product and technical specification. This is the source of truth.
3. `docs/RAYDIUM_LAUNCHLAB.md`: how we plug into LaunchLab, plus a list of facts you must verify against the Raydium SDK, IDL, or on-chain accounts before relying on them.
4. `config/fees.json`: the canonical fee constants. Never hard-code fee numbers anywhere else.
5. `prisma/schema.prisma`: draft data model. Improve it where needed.
6. `prototype/backflow.html`: the approved UI. Open it in a browser. Rebuild it faithfully in Next.js (layout, colors, typography, the particle-ring hero, the ticker, the sparklines, every page and state). All data in the prototype is simulated; in the real app every number must come from chain data or our database.

## How to work

- Work through the milestones in `docs/SPEC.md` §13 in order. At the end of each milestone, stop and give me a short summary: what works, how to run it, and what is left.
- Start on **devnet** (or mainnet-fork / local validator if LaunchLab is unavailable on devnet). Do not deploy anything to mainnet or send any mainnet transaction until I explicitly say so.
- Where `docs/RAYDIUM_LAUNCHLAB.md` marks something as **VERIFY**, check it against the SDK source (`@raydium-io/raydium-sdk-v2`, `src/raydium/launchpad/`), the LaunchLab IDL, the official demo repo (`raydium-sdk-V2-demo/src/launchpad`), or the live on-chain account. If reality differs from the spec, follow reality, update the doc, and tell me what changed.
- Never commit private keys, seed phrases, API keys, or `.env` files. Use `config/.env.example` as the template.
- Write tests for all money math: fee splits, buyback budgets, time-weighted shares, forfeiture, exclusions, and rounding. Money math must use integer base units (lamports and token base units), never floats.
- If a requirement is ambiguous, or `docs/SPEC.md` §14 lists it as an open decision, pick the default written there, note it in `docs/DECISIONS.md`, and keep going.

Begin with Milestone 1.
