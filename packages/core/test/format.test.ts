import { describe, expect, it } from "vitest";
import { BRAND, COPY, META_DESCRIPTION, exampleTrade } from "../src/brand";
import { ago, cnum, everyInterval, mmss, pct, ppmPct, progress, short, sol, solFixed, tokens, usd } from "../src/format";
import { duplicateTickerMessage, normalizeTicker, tickerKey, validateName, validateTicker } from "../src/validate";

describe("formatters (match prototype/backflow.html)", () => {
  it("usd", () => {
    expect(usd(2_600_000)).toBe("$2.60M");
    expect(usd(45_600)).toBe("$45.6K");
    expect(usd(4_560)).toBe("$4.56K");
    expect(usd(123.4)).toBe("$123");
    expect(usd(1.234)).toBe("$1.23");
    expect(usd(0.00421)).toBe("$0.0042");
    expect(usd(null)).toBe("–");
  });

  it("cnum", () => {
    expect(cnum(18_400_000)).toBe("18.40M");
    expect(cnum(212_000)).toBe("212.0K");
    expect(cnum(0)).toBe("0");
    expect(cnum(0.42)).toBe("0.4200");
  });

  it("sol from lamports", () => {
    expect(sol(1_000_000_000n)).toBe("1.00");
    expect(sol("123456000000")).toBe("123.5");
    expect(sol(4_500_000n)).toBe("0.004");
    expect(solFixed(420_000_000n)).toBe("0.42");
    expect(solFixed(1_999_999_999n)).toBe("1.99");
  });

  it("tokens from base units (6 decimals)", () => {
    expect(tokens(18_400_000_000_000n)).toBe("18.40M");
  });

  it("pct, mmss, short, ago", () => {
    expect(pct(12.34)).toBe("+12.3%");
    expect(pct(-4)).toBe("-4.0%");
    expect(mmss(65)).toBe("1:05");
    expect(mmss(-3)).toBe("0:00");
    expect(short("Gq4mABCDEFGHJKLMNPQR8VtZ")).toBe("Gq4m…8VtZ");
    expect(ago(0, 30_000)).toBe("30s ago");
    expect(ago(0, 5 * 60_000)).toBe("5m ago");
  });

  it("ppmPct prints exact percents with no float error", () => {
    expect(ppmPct(4500n)).toBe("0.45%");
    expect(ppmPct(2250n)).toBe("0.225%");
    expect(ppmPct(1750n)).toBe("0.175%");
    expect(ppmPct(2500n)).toBe("0.25%");
    expect(ppmPct(11000n)).toBe("1.1%");
    expect(ppmPct(12500n)).toBe("1.25%");
  });

  it("everyInterval", () => {
    expect(everyInterval(60)).toBe("minute");
    expect(everyInterval(300)).toBe("5 minutes");
    expect(everyInterval(3600)).toBe("hour");
    expect(everyInterval(45)).toBe("45 seconds");
  });

  it("progress clamps to [0, 1]", () => {
    expect(progress(500_000_000n, 1_000_000_000n)).toBe(0.5);
    expect(progress("2000", "1000")).toBe(1);
    expect(progress(1n, 0n)).toBe(0);
  });
});

describe("copy derived from config", () => {
  it("reads every fee from config/fees.json", () => {
    expect(COPY.total).toBe("1.1%");
    expect(COPY.holders).toBe("0.45%");
    expect(COPY.platform).toBe("0.225%");
    expect(COPY.creator).toBe("0.175%");
    expect(COPY.raydium).toBe("0.25%");
    expect(COPY.buybackThresholdSol).toBe("1");
    expect(COPY.graduationSol).toBe("85");
    expect(COPY.maxImpact).toBe("1%");
    expect(COPY.payoutEvery).toBe("5 minutes");
    expect(META_DESCRIPTION).toContain("0.45%");
  });

  it("computes the 1 SOL example trade", () => {
    const e = exampleTrade();
    expect(e.totalFee).toBe(11_000_000n);
    expect(e.holders).toBe(4_500_000n);
  });
});

describe("launch validation", () => {
  it("normalizes tickers", () => {
    expect(normalizeTicker("mo-chi!")).toBe("MOCHI");
    expect(normalizeTicker("abcdefghijklmnop")).toBe("ABCDEFGHIJ");
    expect(tickerKey(" MOCHI ")).toBe("mochi");
  });

  it("validates names and tickers with prototype copy", () => {
    expect(validateName("M")).toBe("Give your coin a name, 2 to 32 characters.");
    expect(validateName("Mochi")).toBeNull();
    expect(validateTicker("")).toBe("Add a ticker, 1 to 10 letters or numbers.");
    expect(validateTicker("MOCHI")).toBeNull();
    expect(duplicateTickerMessage("MOCHI")).toBe(`$MOCHI already exists on ${BRAND.name}. Pick another ticker.`);
  });
});
