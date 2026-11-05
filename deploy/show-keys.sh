#!/bin/bash
# Show every Rebuy wallet's address and private key on this screen, so the owner can keep a copy offline.
#   sudo bash /opt/backflow/deploy/show-keys.sh
# The four server wallets come from /etc/backflow/keys. The treasury (where the platform's profit goes) is created
# here the first time. Its private key is never written to disk: only its address, in /etc/backflow/treasury.pub,
# which mainnet-1-prepare.sh then uses. The screen and scrollback are cleared afterwards.
set -euo pipefail
APP=${APP:-/opt/backflow}
KEYS=${KEYS:-/etc/backflow/keys}
LIVE=${LIVE:-/etc/backflow-live}
TFILE=${TFILE:-/etc/backflow/treasury.pub}
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
[ -f "$KEYS/platform-fee.json" ] || { echo "No wallets yet. Run deploy/mainnet-1-prepare.sh first."; exit 1; }

OLDT=$(cat "$TFILE" 2>/dev/null || true)
[ -n "$OLDT" ] || OLDT=$( { grep -m1 '^TREASURY_PUBKEY=' "$LIVE/common.env" 2>/dev/null || true; } | cut -d= -f2-)

T=$(cd "$APP/packages/chain" && KEYS="$KEYS" OLDT="$OLDT" node -e '
const fs = require("fs"), { Keypair } = require("@solana/web3.js"), b = require("bs58"), e = b.default || b;
const line = "=".repeat(64), out = [];
// One entry per key: with two wallets (D-045) the three worker files hold the same server wallet.
const seen = new Map();
for (const n of ["platform-admin", "platform-fee", "buyback", "distributor"]) {
  const p = `${process.env.KEYS}/${n}.json`;
  if (!fs.existsSync(p)) continue;
  const k = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  const id = k.publicKey.toBase58();
  if (seen.has(id)) seen.get(id).names.push(n);
  else seen.set(id, { names: [n], k });
}
for (const [id, { names, k }] of seen) {
  const label = names.length > 1 ? "server wallet" : `${names[0]}  (server wallet)`;
  out.push(`${label}\n  address:     ${id}\n  private key: ${e.encode(k.secretKey)}`);
}
let t = process.env.OLDT;
if (t) out.push(`treasury  (your profit wallet)\n  address:     ${t}\n  private key: shown once when it was created; never stored on this server`);
else {
  const k = Keypair.generate();
  t = k.publicKey.toBase58();
  out.push(`treasury  (NEW, your profit wallet; NOT saved on this server)\n  address:     ${t}\n  private key: ${e.encode(k.secretKey)}`);
}
console.error(`\n${line}\n${out.join("\n\n")}\n${line}\nSave every private key in a password manager or on paper.\nNever screenshot this or send it to anyone, Claude included.\n`);
console.log(t);')

read -rp "Saved them all? Type YES (anything else: nothing is kept): " ok
{ clear 2>/dev/null || true; printf '\033[3J'; }
[ "$ok" = YES ] || { echo "Not confirmed.${OLDT:+ The treasury is unchanged.}${OLDT:- No treasury was saved; run again for a new one.}"; exit 1; }
if [ -z "$OLDT" ]; then
  mkdir -p "$(dirname "$TFILE")"
  echo "$T" > "$TFILE"
  chmod 644 "$TFILE"
fi
echo "Private keys cleared from the screen."
echo "treasury address: $T"
