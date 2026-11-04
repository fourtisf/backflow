"use client";

import { sol, type BuiltTxDTO } from "@backflow/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { createElement, useState } from "react";
import { toast, useLive, useRewards } from "./store";
import { apiPost, explorerTx, signAndSend } from "./tx";

/**
 * Creator fee claims. "launchlab" empties the creator's LaunchLab vault (all their coins on the curve);
 * "cpmm" collects one graduated coin's Raydium pool creator fees.
 */
export function useCreatorClaim() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const isLive = useLive((s) => s.stats?.mode === "live");
  const reload = useRewards((s) => s.load);
  const [busy, setBusy] = useState<string | null>(null);

  const claim = async (kind: "launchlab" | "cpmm", mint?: string) => {
    if (!isLive) {
      toast("Claiming creator fees isn't live yet in this build. Nothing was sent.");
      return;
    }
    if (!wallet.publicKey) return;
    const key = kind === "cpmm" ? `cpmm:${mint}` : "launchlab";
    setBusy(key);
    try {
      const built = await apiPost<BuiltTxDTO>("/creator/claim-tx", { creator: wallet.publicKey.toBase58(), kind, mint });
      const sig = await signAndSend(wallet, connection, built.tx);
      toast(
        createElement(
          "span",
          null,
          "Claimed ",
          createElement("b", { className: "num" }, `${sol(built.expectedOut)} SOL`),
          " in creator fees. ",
          createElement("a", { href: explorerTx(sig), target: "_blank", rel: "noreferrer", style: { color: "var(--current)" } }, "View"),
        ),
      );
      void reload(wallet.publicKey.toBase58());
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  return { claim, busy };
}
