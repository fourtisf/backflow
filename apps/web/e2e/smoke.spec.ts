import { expect, test, type Page } from "@playwright/test";

const errors = (page: Page) => {
  const list: string[] = [];
  page.on("pageerror", (e) => list.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|ERR_|api\.devnet|fonts\.g/.test(m.text())) list.push(m.text());
  });
  return list;
};

const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

test("board renders live data, tabs work by keyboard, no sideways scroll", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Trade fees that flow back to holders." })).toBeVisible();
  await expect(page.locator(".row:not(.head)").first()).toBeVisible();
  await expect(page.getByText("Simulated data").first()).toBeVisible();
  const trending = page.getByRole("tab", { name: "Trending" });
  await trending.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "New" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "New" })).toBeFocused();
  await noSideScroll(page);
  expect(errs).toEqual([]);
});

test("coin page shows chart, trade panel estimates and the fee breakdown", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/");
  await page.locator(".row:not(.head)").first().click();
  await expect(page.getByRole("img", { name: /Market cap chart/ })).toBeVisible();
  await page.locator("#amt").fill("1");
  await expect(page.locator(".est .l b").first()).not.toHaveText("–");
  await page.getByRole("tab", { name: "Sell" }).click();
  await expect(page.getByRole("button", { name: /Connect wallet to sell/ })).toBeVisible();
  await noSideScroll(page);
  expect(errs).toEqual([]);
});

test("launch form validates and blocks duplicate tickers", async ({ page }) => {
  await page.goto("/launch");
  await page.locator("#fTicker").fill("mochi");
  await expect(page.getByText("$MOCHI already exists on Backflow. Pick another ticker.")).toBeVisible();
  await expect(page.locator("#fTicker")).toHaveValue("MOCHI");
  await noSideScroll(page);
});

test("how it works and rewards gate render", async ({ page }) => {
  await page.goto("/how");
  await expect(page.getByRole("heading", { name: /Where the .* goes/ })).toBeVisible();
  await noSideScroll(page);
  await page.goto("/rewards");
  await expect(page.getByRole("heading", { name: "Connect a wallet to see what you've earned" })).toBeVisible();
});

test("reduced motion still draws the hero frame", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("/");
  const drawn = await page.locator(".hero-visual canvas").evaluate((c: HTMLCanvasElement) => c.width > 0 && c.height > 0);
  expect(drawn).toBe(true);
  await ctx.close();
});
