/**
 * Raydium program and account addresses per cluster, as plain strings so this
 * package stays free of Solana dependencies.
 *
 * Verified against @raydium-io/raydium-sdk-v2 0.2.81-alpha
 * (src/common/programId.ts, commit f3fa7cbf) and raydium-cpi declare_id!.
 * Global config PDAs re-derived from seeds ["global_config", wSOL, u8 0, u16 0].
 * See docs/DECISIONS.md D-002.
 */

export type Cluster = "devnet" | "mainnet-beta";

export interface RaydiumAddresses {
  launchLabProgram: string;
  launchLabAuth: string;
  /** GlobalConfig for wSOL, constant-product curve (type 0), index 0. */
  globalConfigWsolCp: string;
  cpmmProgram: string;
  cpmmAuth: string;
  /** Burn & Earn: one lock program for CLMM and CPMM LP. */
  lockProgram: string;
  lockCpmmAuth: string;
  /** Raydium's own LaunchLab platform (for reference, not ours). */
  raydiumPlatform: string;
}

export const RAYDIUM: Record<Cluster, RaydiumAddresses> = {
  "mainnet-beta": {
    launchLabProgram: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
    launchLabAuth: "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh",
    globalConfigWsolCp: "6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX",
    cpmmProgram: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    cpmmAuth: "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
    lockProgram: "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE",
    lockCpmmAuth: "3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH",
    raydiumPlatform: "4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4",
  },
  devnet: {
    launchLabProgram: "DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6",
    launchLabAuth: "5xqNaZXX5eUi4p5HU4oz9i5QnwRNT2y6oN7yyn4qENeq",
    globalConfigWsolCp: "7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt",
    cpmmProgram: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
    cpmmAuth: "CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq",
    lockProgram: "DRay25Usp3YJAi7beckgpGUC7mGJ2cR1AVPxhYfwVCUX",
    lockCpmmAuth: "7qWVV8UY2bRJfDLP4s37YzBPKUkVB46DStYJBpYbQzu3",
    raydiumPlatform: "2Jx4KTDrVSdWNazuGpcA8n3ZLTRGGBDxAWhuKe2Xcj2a",
  },
};

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function parseCluster(v: string | undefined): Cluster {
  if (!v || v === "devnet") return "devnet";
  if (v === "mainnet-beta" || v === "mainnet") return "mainnet-beta";
  throw new Error(`Unknown SOLANA_CLUSTER "${v}". Use devnet or mainnet-beta.`);
}
