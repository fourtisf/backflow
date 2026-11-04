import { expect, test, type Page } from "@playwright/test";
import { Keypair } from "@solana/web3.js";

/**
 * Two fake Wallet Standard wallets (no extension needed), registered the way real wallets do:
 * "Backpack" and "Magic Eden", each with one account. They can connect but refuse to sign.
 */
const A = Keypair.generate().publicKey;
const B = Keypair.generate().publicKey;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const ICON = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#888"/></svg>').toString("base64");

async function installFakeWallets(page: Page) {
  const wallets = [
    { name: "Backpack", address: A.toBase58(), bytes: [...A.toBytes()] },
    { name: "Magic Eden", address: B.toBase58(), bytes: [...B.toBytes()] },
  ];
  await page.addInitScript(
    ({ wallets, icon }) => {
      for (const def of wallets) {
        const listeners: Record<string, ((p: unknown) => void)[]> = {};
        const chains = ["solana:devnet", "solana:mainnet", "solana:testnet"];
        const account = { address: def.address, publicKey: new Uint8Array(def.bytes), chains, features: ["solana:signTransaction", "solana:signMessage"] };
        let accounts: (typeof account)[] = [];
        const emit = () => (listeners.change ?? []).forEach((f) => f({ accounts }));
        const refuse = async () => {
          throw new Error("test wallet");
        };
        const wallet = {
          version: "1.0.0",
          name: def.name,
          icon,
          chains,
          get accounts() {
            return accounts;
          },
          features: {
            "standard:connect": { version: "1.0.0", connect: async () => ((accounts = [account]), emit(), { accounts }) },
            "standard:disconnect": { version: "1.0.0", disconnect: async () => ((accounts = []), emit()) },
            "standard:events": { version: "1.0.0", on: (ev: string, fn: (p: unknown) => void) => ((listeners[ev] ??= []).push(fn), () => (listeners[ev] = listeners[ev]!.filter((x) => x !== fn))) },
            "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: refuse },
            "solana:signMessage": { version: "1.0.0", signMessage: refuse },
          },
        };
        const callback = ({ register }: { register: (w: unknown) => void }) => register(wallet);
        window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
        window.addEventListener("wallet-standard:app-ready", (e) => callback((e as CustomEvent).detail));
      }
    },
    { wallets, icon: ICON },
  );
}

test("wallet list shows every wallet with its logo", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /connect/i }).first().click();
  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await expect(dialog).toBeVisible();
  for (const name of ["Phantom", "Solflare", "Backpack", "OKX Wallet", "Coinbase Wallet", "Trust Wallet", "Bitget Wallet", "Magic Eden", "Exodus"]) {
    await expect(dialog.locator(".witem", { hasText: name })).toHaveCount(1);
  }
  // every row has a real logo (no plain placeholders)
  expect(await dialog.locator(".witem img.wlogo").count()).toBe(await dialog.locator(".witem").count());
  expect(await dialog.locator(".witem .wi-ph").count()).toBe(0);
});

test("connect, add a second wallet, switch, and see rewards for all wallets", async ({ page }) => {
  await installFakeWallets(page);
  await page.goto("/rewards");

  // connect Backpack
  await page.getByRole("button", { name: /connect/i }).first().click();
  await page.getByRole("dialog").locator(".witem", { hasText: "Backpack" }).click();
  const button = page.getByRole("button", { name: new RegExp(`Connected with Backpack: ${short(A.toBase58())}`) });
  await expect(button).toBeVisible();

  // add Magic Eden next to it
  await button.click();
  await page.getByRole("menuitem", { name: "Add another wallet" }).click();
  await expect(page.getByRole("dialog", { name: "Add another wallet" })).toBeVisible();
  await page.getByRole("dialog").locator(".witem", { hasText: "Magic Eden" }).click();
  const second = page.getByRole("button", { name: new RegExp(`Connected with Magic Eden: ${short(B.toBase58())}`) });
  await expect(second).toBeVisible();

  // both are remembered; switch back to Backpack from the menu
  await second.click();
  const other = page.getByRole("menuitem", { name: new RegExp(short(A.toBase58())) });
  await expect(other).toBeVisible();
  await other.click();
  await expect(page.getByRole("button", { name: new RegExp(`Connected with Backpack: ${short(A.toBase58())}`) })).toBeVisible();

  // rewards: pick "All wallets" and see one row per wallet
  await page.getByRole("tab", { name: "All 2 wallets" }).click();
  await expect(page.getByRole("heading", { name: "By wallet" })).toBeVisible();
  const rows = page.locator(".tbl", { has: page.getByText("Coins held") }).locator("tbody tr");
  await expect(rows).toHaveCount(2);

  // remembered after a reload (this device only)
  await page.reload();
  await expect(page.getByRole("tab", { name: "All 2 wallets" })).toBeVisible();
});
