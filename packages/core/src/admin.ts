/** The message an admin wallet signs to use /admin (verified by the API; valid 15 minutes). */
export function adminMessage(wallet: string, issuedAtMs: number): string {
  return `Backflow admin\nWallet: ${wallet}\nIssued: ${new Date(issuedAtMs).toISOString()}`;
}
export const ADMIN_TTL_MS = 15 * 60_000;

/** The message a holder signs to link payout alerts on Telegram (valid 10 minutes). */
export function telegramLinkMessage(wallet: string, issuedAtMs: number): string {
  return `Backflow payout alerts\nWallet: ${wallet}\nIssued: ${new Date(issuedAtMs).toISOString()}`;
}
