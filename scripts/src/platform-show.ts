/**
 * Print the live LaunchLab GlobalConfig, our PlatformConfig and the CPMM fee
 * tiers. Use the output as evidence for the VERIFY checklist in docs/DECISIONS.md.
 *
 *   pnpm platform:show
 */
import { RATES, ppmPct } from "@backflow/core";
import { getPdaPlatformId } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { readAmmConfigs, readGlobalConfig, readPlatform } from "./lib/decode";
import { addresses, cluster, connection, pubkeyFrom } from "./lib/env";

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main() {
  const c = cluster({ readOnly: true });
  const conn = connection(c);
  const A = addresses(c);
  const gc = await readGlobalConfig(conn, A.globalConfig);
  console.log(`GlobalConfig ${A.globalConfig.toBase58()}:\n${gc ? json(gc) : "not found"}`);
  if (gc) console.log(`protocol fee ${ppmPct(gc.tradeFeeRate)} (config expects ${ppmPct(RATES.raydiumProtocolPpm)})`);

  let platformId: PublicKey | null = null;
  const env = process.env.PLATFORM_CONFIG_PUBKEY;
  if (env && !env.startsWith("REPLACE")) platformId = new PublicKey(env);
  else {
    try {
      platformId = getPdaPlatformId(A.launchLabProgram, pubkeyFrom("PLATFORM_ADMIN_KEYPAIR_PATH")).publicKey;
    } catch {
      platformId = null;
    }
  }
  if (platformId) {
    const p = await readPlatform(conn, platformId);
    console.log(`\nPlatformConfig ${platformId.toBase58()}:\n${p ? json(p) : "not created yet (run pnpm platform:create)"}`);
  }

  const tiers = await readAmmConfigs(conn, A.cpmmProgram);
  console.log(`\nCPMM AmmConfig tiers:\n${json(tiers)}`);
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
