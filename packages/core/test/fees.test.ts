import { describe, expect, it } from "vitest";
import raw from "../../../config/fees.json";
import { FEES, PPM, RATES, parseFeeConfig } from "../src/fees";

describe("fees.json", () => {
  it("derives the 2/3 holders and 1/3 platform shares of the platform fee", () => {
    expect(RATES.platformFeePpm).toBe(6750n);
    expect(RATES.holdersPpm).toBe(4500n); // 0.45%
    expect(RATES.platformSharePpm).toBe(2250n); // 0.225%
    expect(RATES.creatorFeePpm).toBe(1750n); // 0.175%
    expect(RATES.raydiumProtocolPpm).toBe(2500n); // 0.25%
  });

  it("adds up to the 1.1% total target", () => {
    expect(RATES.totalPpm).toBe(11000n);
    expect(RATES.totalPpm).toBe(RATES.totalTargetPpm);
    expect(RATES.holdersPpm + RATES.platformSharePpm + RATES.creatorFeePpm + RATES.raydiumProtocolPpm).toBe(RATES.totalPpm);
  });

  it("parses curve, buyback and payout parameters as integers", () => {
    expect(FEES.curve.supplyBaseUnits).toBe(1_000_000_000_000_000n);
    expect(FEES.curve.sellOnCurveBaseUnits).toBe(800_000_000_000_000n);
    expect(FEES.curve.graduationTargetLamports).toBe(85_000_000_000n);
    expect(FEES.buyback.thresholdLamports).toBe(1_000_000_000n);
    expect(FEES.payout.intervalSec).toBe(300);
  });

  it("locks 100% of migrated LP to the platform", () => {
    const s = FEES.migrateCpLockNftScale;
    expect(s.platformScale).toBe(PPM);
    expect(s.creatorScale).toBe(0n);
    expect(s.burnScale).toBe(0n);
  });

  it("rejects a config whose rates do not add up to the target", () => {
    const bad = structuredClone(raw);
    bad.ratesPpm.creatorFeeRate = 2000;
    expect(() => parseFeeConfig(bad)).toThrow(/totalTarget/);
  });

  it("rejects a platform split that would make the holders' rate fractional", () => {
    const bad = structuredClone(raw);
    bad.ratesPpm.platformFeeRate = 6751;
    bad.ratesPpm.totalTarget = 11001;
    expect(() => parseFeeConfig(bad)).toThrow(/divide evenly/);
  });

  it("rejects lock scales that do not sum to 1_000_000", () => {
    const bad = structuredClone(raw);
    bad.graduation.migrateCpLockNftScale.burnScale = 1;
    expect(() => parseFeeConfig(bad)).toThrow(/sum to 1_000_000/);
  });

  it("rejects non-integer amounts", () => {
    const bad = structuredClone(raw);
    bad.buyback.thresholdLamports = "1.5";
    expect(() => parseFeeConfig(bad)).toThrow(/integer/);
  });
});
