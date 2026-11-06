/**
 * Launch reservations that still block a ticker (D-058).
 *
 * A launch reserves its ticker for 2 minutes (LaunchIntent). If the launch lands on chain but the indexer
 * hasn't recorded the coin yet, for example while it is slow, the ticker looked free again after those 2
 * minutes and the same ticker could be launched twice, even by the same wallet retrying. So a reservation
 * from the last hour whose mint already exists on chain keeps blocking the ticker until the indexer takes
 * over (it deletes the reservation when it creates the coin).
 */
import { duplicateTickerMessage, launchingTickerMessage } from "@backflow/core";
import type { PrismaClient } from "@backflow/db";

/** How far back a reservation is checked against the chain. */
export const LANDED_LOOKBACK_MS = 3_600_000;

export interface MintChecker {
  /** true: the mint account exists; false: it doesn't; null: the RPC couldn't tell. */
  mintExists(mint: string): Promise<boolean | null>;
}

/** Mints already seen on chain (they never disappear), so a ticker check costs at most one RPC call per mint. */
const landed = new Set<string>();

/** Why `wallet` can't launch this ticker because of a reservation, or null when nothing blocks it. */
export async function launchBlock(db: PrismaClient, chain: MintChecker | null, key: string, ticker: string, wallet: string | null): Promise<string | null> {
  const now = Date.now();
  const intents = await db.launchIntent.findMany({
    where: { tickerKey: key, expiresAt: { gt: new Date(now - LANDED_LOOKBACK_MS) } },
    select: { mint: true, creator: true, expiresAt: true },
    orderBy: { expiresAt: "desc" },
    take: 10,
  });
  // another wallet is in the middle of launching it
  if (intents.some((i) => i.expiresAt.getTime() > now && i.creator !== wallet)) return launchingTickerMessage(ticker);
  if (!chain) return null;
  // a launch of this ticker (anyone's, this wallet's too) that already landed and isn't indexed yet
  for (const i of intents) {
    const on = landed.has(i.mint) ? true : await chain.mintExists(i.mint);
    if (on === null) return `Couldn't check whether an earlier $${ticker} launch went through. Try again in a moment.`;
    if (!on) continue;
    if (landed.size > 5000) landed.clear();
    landed.add(i.mint);
    return i.creator === wallet ? `Your $${ticker} launch already went through. It shows up on the board in a few seconds.` : duplicateTickerMessage(ticker);
  }
  return null;
}
