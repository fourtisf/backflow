import { describe, expect, it } from "vitest";
import { SIGN_IN_PURPOSES, signInMessage } from "../src/signin";

const base = { wallet: "A1ice111111111111111111111111111111111111111", nonce: "n0nce", issuedAt: "2026-11-04T12:00:00.000Z", domain: "backflow.example", cluster: "devnet" } as const;

describe("signInMessage", () => {
  it("starts with the domain and names wallet, purpose, cluster, nonce and time", () => {
    const m = signInMessage({ ...base, purpose: "launch" });
    const lines = m.split("\n");
    expect(lines[0]).toBe("backflow.example wants you to sign in with your Solana account:");
    expect(lines[1]).toBe(base.wallet);
    expect(m).toContain("Purpose: launch");
    expect(m).toContain("Domain: backflow.example");
    expect(m).toContain("Cluster: devnet");
    expect(m).toContain("Nonce: n0nce");
    expect(m).toContain("Issued At: 2026-11-04T12:00:00.000Z");
  });

  it("differs for every purpose, domain, cluster and nonce, so a signature can't be reused elsewhere", () => {
    const all = new Set<string>();
    for (const purpose of SIGN_IN_PURPOSES) {
      all.add(signInMessage({ ...base, purpose }));
      all.add(signInMessage({ ...base, purpose, domain: "staging.backflow.example" }));
      all.add(signInMessage({ ...base, purpose, cluster: "mainnet-beta" }));
      all.add(signInMessage({ ...base, purpose, nonce: "other" }));
    }
    expect(all.size).toBe(SIGN_IN_PURPOSES.length * 4);
  });
});
