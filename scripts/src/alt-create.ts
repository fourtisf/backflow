/**
 * Create an address lookup table with the accounts every Backflow transaction
 * shares (programs, configs, vault authorities), so launch + first buy and
 * long payout batches stay under the 1232-byte limit with room to spare.
 *
 *   pnpm alt:create            dry run: prints the addresses
 *   pnpm alt:create -- --send  creates and extends the table (payer: platform fee wallet)
 *
 * Put the printed address in BACKFLOW_ALT. Mainnet needs owner approval (env guard).
 */
import { addresses, cluster, connection, flag, loadKeypair, platformFeeVault } from "@backflow/chain";
import { getPdaCpiEvent, getPdaLaunchpadAuth } from "@raydium-io/raydium-sdk-v2";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AddressLookupTableProgram, ComputeBudgetProgram, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

async function main() {
  const c = cluster();
  const conn = connection(c);
  const A = addresses(c);
  const platform = new PublicKey(process.env.PLATFORM_CONFIG_PUBKEY ?? "");
  const list = [
    A.launchLabProgram,
    getPdaLaunchpadAuth(A.launchLabProgram).publicKey,
    getPdaCpiEvent(A.launchLabProgram).publicKey,
    A.globalConfig,
    platform,
    platformFeeVault(A.launchLabProgram, platform),
    PublicKey.findProgramAddressSync([Buffer.from("platform_fee_vault_auth_seed")], A.launchLabProgram)[0],
    PublicKey.findProgramAddressSync([Buffer.from("creator_fee_vault_auth_seed")], A.launchLabProgram)[0],
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    SYSVAR_RENT_PUBKEY,
    new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
    A.cpmmProgram,
    A.lockProgram,
  ];
  console.log(`cluster ${c}; ${list.length} addresses:`);
  for (const a of list) console.log("  " + a.toBase58());
  if (!flag("send")) {
    console.log("\nDry run. Re-run with --send to create the table.");
    return;
  }
  const payer = loadKeypair("PLATFORM_FEE_WALLET_KEYPAIR_PATH");
  // The table's address comes from a recent slot, which the program checks against the SlotHashes of the
  // bank that runs the transaction. Behind a load-balanced RPC the node that simulates can be behind the one
  // that answered getSlot ("<slot> is not a recent slot"), so: ask for a node past that slot (minContextSlot)
  // and retry with a fresh slot. A failed simulation sends nothing and costs nothing.
  for (let attempt = 1; ; attempt++) {
    const slot = await conn.getSlot("finalized");
    const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
    const extend = AddressLookupTableProgram.extendLookupTable({ authority: payer.publicKey, payer: payer.publicKey, lookupTable: table, addresses: list });
    // Frozen by default: a frozen table can't be deactivated or closed by the (hot) authority key, so no
    // key compromise can break every transaction that references it. Pass --no-freeze to keep it extendable.
    const tx = new Transaction().add(create, extend);
    if (!flag("no-freeze")) tx.add(AddressLookupTableProgram.freezeLookupTable({ authority: payer.publicKey, lookupTable: table }));
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed", preflightCommitment: "confirmed", minContextSlot: slot + 1 });
      console.log(`\ncreated ${table.toBase58()}${flag("no-freeze") ? "" : " (frozen)"}  ${sig}\n\nAdd to .env:\nBACKFLOW_ALT=${table.toBase58()}`);
      return;
    } catch (e) {
      if (attempt < 6 && isStaleSlot(e)) {
        console.log(`slot ${slot} was not recent on the RPC node yet; retrying (${attempt}/5)…`);
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
        continue;
      }
      throw e;
    }
  }
}

/** The ALT program rejected the recent slot, or the RPC node hadn't reached minContextSlot yet. */
function isStaleSlot(e: unknown): boolean {
  const logs = (e as { logs?: string[] } | null)?.logs ?? [];
  const text = `${(e as Error)?.message ?? e} ${logs.join(" ")}`;
  return /is not a recent slot|Minimum context slot has not been reached/i.test(text);
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
