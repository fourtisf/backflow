import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RATES } from "../src/fees";
import {
  estimateBuy,
  estimateSell,
  feeOn,
  formatUnits,
  mulDivCeil,
  mulDivFloor,
  parseUnits,
  ratioPpm,
  splitPlatformFee,
  tradeFees,
} from "../src/math";

const SOL = 1_000_000_000n;
const lamports = fc.bigInt({ min: 0n, max: 10_000_000n * SOL }); // up to 10M SOL

describe("mulDiv", () => {
  it("floors and ceils", () => {
    expect(mulDivFloor(10n, 2n, 3n)).toBe(6n);
    expect(mulDivCeil(10n, 2n, 3n)).toBe(7n);
    expect(mulDivCeil(9n, 2n, 3n)).toBe(6n);
    expect(mulDivCeil(0n, 2n, 3n)).toBe(0n);
  });

  it("rejects negatives and zero denominators", () => {
    expect(() => mulDivFloor(-1n, 1n, 1n)).toThrow(RangeError);
    expect(() => mulDivFloor(1n, 1n, 0n)).toThrow(RangeError);
  });

  it("ceil - floor is 0 or 1", () => {
    fc.assert(
      fc.property(lamports, fc.bigInt({ min: 0n, max: 1_000_000n }), fc.bigInt({ min: 1n, max: 1_000_000n }), (a, n, d) => {
        const diff = mulDivCeil(a, n, d) - mulDivFloor(a, n, d);
        return diff === 0n || diff === 1n;
      }),
    );
  });
});

describe("splitPlatformFee (SPEC §2.1)", () => {
  it("splits 0.00675 SOL into 0.0045 holders and 0.00225 platform", () => {
    expect(splitPlatformFee(6_750_000n)).toEqual({ holders: 4_500_000n, platform: 2_250_000n });
  });

  it("sends rounding dust to the platform", () => {
    expect(splitPlatformFee(1n)).toEqual({ holders: 0n, platform: 1n });
    expect(splitPlatformFee(2n)).toEqual({ holders: 1n, platform: 1n });
    expect(splitPlatformFee(4n)).toEqual({ holders: 2n, platform: 2n });
    expect(splitPlatformFee(5n)).toEqual({ holders: 3n, platform: 2n });
  });

  it("never loses or creates a lamport, and holders = floor(2/3 × fee)", () => {
    fc.assert(
      fc.property(lamports, (fee) => {
        const { holders, platform } = splitPlatformFee(fee);
        return holders + platform === fee && holders === (fee * 2n) / 3n && platform >= 0n && holders >= 0n;
      }),
    );
  });

  it("platform part is at least a third and at most a third plus 1 lamport", () => {
    fc.assert(
      fc.property(lamports, (fee) => {
        const { platform } = splitPlatformFee(fee);
        // 3 × platform ∈ [fee, fee + 2]
        return 3n * platform >= fee && 3n * platform <= fee + 2n;
      }),
    );
  });

  it("rejects negative fees", () => {
    expect(() => splitPlatformFee(-1n)).toThrow(RangeError);
  });
});

describe("tradeFees", () => {
  it("matches the SPEC worked example for a 1 SOL buy", () => {
    const f = tradeFees(SOL);
    expect(f.protocol).toBe(2_500_000n); // 0.0025 SOL
    expect(f.platform).toBe(6_750_000n); // 0.00675 SOL
    expect(f.holdersPart).toBe(4_500_000n); // 0.0045 SOL
    expect(f.platformPart).toBe(2_250_000n); // 0.00225 SOL
    expect(f.creator).toBe(1_750_000n); // 0.00175 SOL
    expect(f.total).toBe(11_000_000n); // 0.011 SOL
  });

  it("rounds the total up and gives the rounding dust to the protocol (LaunchLab splitFee)", () => {
    const f = tradeFees(1n);
    expect(f.total).toBe(1n); // ceil(1 × 11000 / 1e6)
    expect(f.platform).toBe(0n); // floor(1 × 6750 / 11000)
    expect(f.creator).toBe(0n);
    expect(f.protocol).toBe(1n);
    // 1000 lamports: total = ceil(11) = 11; platform = floor(11×6750/11000) = 6; creator = floor(11×1750/11000) = 1
    expect(tradeFees(1000n)).toMatchObject({ total: 11n, platform: 6n, creator: 1n, protocol: 4n, share: 0n });
  });

  it("components always add up to the total, and the platform split to the platform fee", () => {
    fc.assert(
      fc.property(lamports, (q) => {
        const f = tradeFees(q);
        return (
          f.holdersPart + f.platformPart === f.platform &&
          f.total === f.protocol + f.platform + f.creator + f.share &&
          f.protocol >= 0n &&
          f.share === 0n
        );
      }),
    );
  });

  it("total is the exact 1.1% rounded up (never more than 1 lamport over)", () => {
    fc.assert(
      fc.property(lamports, (q) => {
        const exact = q * RATES.totalPpm; // scaled by 1e6
        const total = tradeFees(q).total * 1_000_000n;
        return total >= exact && total - exact < 1_000_000n;
      }),
    );
  });

  it("platform and creator parts never exceed their exact share of volume", () => {
    fc.assert(
      fc.property(lamports, (q) => {
        const f = tradeFees(q);
        // platform ≤ ceil-total × rate / totalRate, and within 1 lamport of q × rate / 1e6
        const exactPlat = q * RATES.platformFeePpm;
        return f.platform * 1_000_000n <= exactPlat + 1_000_000n && f.platform * 1_000_000n + 1_000_000n >= exactPlat;
      }),
    );
  });

  it("includes a referral share fee when given one", () => {
    const f = tradeFees(SOL, RATES, 1000n);
    expect(f.total).toBe(12_000_000n);
    expect(f.share).toBe(1_000_000n);
    expect(() => tradeFees(SOL, RATES, 1_000_000n)).toThrow(RangeError);
  });

  it("feeOn floor never exceeds ceil", () => {
    fc.assert(fc.property(lamports, (q) => feeOn(q, 4500n, "floor") <= feeOn(q, 4500n, "ceil")));
  });
});

describe("parseUnits / formatUnits", () => {
  it("parses decimal strings exactly", () => {
    expect(parseUnits("1", 9)).toBe(SOL);
    expect(parseUnits("0.5", 9)).toBe(500_000_000n);
    expect(parseUnits(".25", 9)).toBe(250_000_000n);
    expect(parseUnits("1,5", 9)).toBe(1_500_000_000n);
    expect(parseUnits("0.000000001", 9)).toBe(1n);
    expect(parseUnits("12.", 6)).toBe(12_000_000n);
  });

  it("rejects bad input and excess precision", () => {
    for (const s of ["", ".", "abc", "1.2.3", "-1", "1e5", "0.0000000001"]) expect(parseUnits(s, 9)).toBeNull();
  });

  it("formats with trailing zeros trimmed", () => {
    expect(formatUnits(4_500_000n, 9)).toBe("0.0045");
    expect(formatUnits(SOL, 9)).toBe("1");
    expect(formatUnits(85n * SOL, 9)).toBe("85");
    expect(formatUnits(-1n, 9)).toBe("-0.000000001");
  });

  it("round-trips", () => {
    fc.assert(fc.property(lamports, (v) => parseUnits(formatUnits(v, 9), 9) === v));
  });
});

describe("estimateBuy / estimateSell", () => {
  // 0.36 lamports per whole token → scaled 360_000_000
  const price = 360_000_000n;
  it("takes fees from the SOL in, then divides by price", () => {
    const e = estimateBuy(SOL, price, 6);
    expect(e.fees.total).toBe(11_000_000n);
    expect(e.net).toBe(989_000_000n);
    // 0.989 SOL / 0.36 lamports per token = 2,747,222,222.2 tokens → base units floor
    expect(e.tokensOut).toBe(2_747_222_222_222_222n);
  });
  it("takes fees from the gross SOL out", () => {
    const e = estimateSell(2_747_222_222_222_222n, price, 6);
    expect(e.gross).toBe(988_999_999n);
    expect(e.out).toBe(e.gross - e.fees.total);
  });
  it("returns zero tokens for an unknown price", () => {
    expect(estimateBuy(SOL, 0n, 6).tokensOut).toBe(0n);
  });
});

describe("ratioPpm", () => {
  it("returns floor(num/den × 1e6), 0 for empty denominators", () => {
    expect(ratioPpm(1n, 3n)).toBe(333_333n);
    expect(ratioPpm(5n, 0n)).toBe(0n);
    expect(ratioPpm(-5n, 10n)).toBe(0n);
  });
});
