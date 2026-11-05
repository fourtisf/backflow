#!/bin/bash
# Two wallets instead of five (DECISIONS.md D-045). Replaces the server's wallets with:
#   - a SERVER WALLET that does every server job: it receives the platform fees, buys back and pays holders.
#     It lives on this server (one key, a copy per worker process);
#   - a TREASURY: your profit wallet and the platform's owner (admin). Its private key is shown once here
#     and never written to this server.
#   sudo bash /opt/backflow/deploy/new-wallets.sh
# Only before the platform is created, and only while the old wallets are empty. The old key files are
# kept in /etc/backflow/keys-old-<time> (root only), not deleted.
set -euo pipefail
APP=${APP:-/opt/backflow}
LIVE=${LIVE:-/etc/backflow-live}
KEYS=${KEYS:-/etc/backflow/keys}
TFILE=${TFILE:-/etc/backflow/treasury.pub}
LAYOUT=${LAYOUT:-/etc/backflow/wallet-layout}
SKIP_BALANCES=${SKIP_BALANCES:-0}   # tests only
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
[ -f "$LIVE/common.env" ] || { echo "Run deploy/mainnet-1-prepare.sh first."; exit 1; }
cur() { { grep -m1 "^$2=" "$LIVE/$1" 2>/dev/null || true; } | cut -d= -f2-; }
setenv() { if grep -q "^$2=" "$LIVE/$1"; then sed -i "s|^$2=.*|$2=$3|" "$LIVE/$1"; else echo "$2=$3" >> "$LIVE/$1"; fi; }
[ -z "$(cur common.env PLATFORM_CONFIG_PUBKEY)" ] || { echo "The platform is already created with the current wallets. Changing them now needs platform:update; ask Claude."; exit 1; }

# 1. the old wallets must be empty, so nothing is left behind
OLD=$(ls "$KEYS"/*.json 2>/dev/null || true)
if [ "$SKIP_BALANCES" != 1 ] && { [ -n "$OLD" ] || [ -s "$TFILE" ]; }; then
  echo "Checking the old wallets are empty..."
  (set -a; . "$LIVE/common.env"; set +a; cd "$APP/packages/chain" && TF="$(cat "$TFILE" 2>/dev/null || true)" node -e '
    const fs = require("fs"), { Connection, Keypair, PublicKey } = require("@solana/web3.js");
    const conn = new Connection(process.env.RPC_URL, "confirmed");
    const addrs = process.argv.slice(1).filter(Boolean).map((p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))).publicKey);
    if (process.env.TF) addrs.push(new PublicKey(process.env.TF));
    (async () => {
      let full = 0;
      for (const a of addrs) { const b = await conn.getBalance(a); if (b > 0) { full++; console.log(`  ${a.toBase58()} holds ${b / 1e9} SOL`); } }
      if (full) { console.log("Move that SOL out first (you have the private keys from show-keys.sh), then run this again."); process.exit(3); }
      console.log("  all empty");
    })().catch((e) => { console.error("Could not check balances: " + e.message); process.exit(4); });' $OLD) || exit 1
fi

# 2. make both wallets in memory and show them once
TMP=$(mktemp -d /dev/shm/rebuy.XXXXXX 2>/dev/null || mktemp -d)
trap 'shred -u "$TMP"/* 2>/dev/null || true; rmdir "$TMP" 2>/dev/null || true' EXIT
chmod 700 "$TMP"
OUT=$(cd "$APP/packages/chain" && TMPD="$TMP" node -e '
const fs = require("fs"), { Keypair } = require("@solana/web3.js"), b = require("bs58"), e = b.default || b;
const s = Keypair.generate(), t = Keypair.generate(), line = "=".repeat(64);
fs.writeFileSync(process.env.TMPD + "/server.json", JSON.stringify(Array.from(s.secretKey)), { mode: 0o600 });
console.error(`\n${line}\n YOUR TWO REBUY WALLETS\n\n 1. TREASURY  (your profit, and owner of the platform)\n    address:     ${t.publicKey.toBase58()}\n    private key: ${e.encode(t.secretKey)}\n    Shown only now. It is NOT saved on this server.\n\n 2. SERVER WALLET  (receives the fees, buys back, pays holders)\n    address:     ${s.publicKey.toBase58()}\n    private key: ${e.encode(s.secretKey)}\n    Also kept on this server, which needs it to work.\n\n Save both private keys in a password manager or on paper.\n Import the treasury into Phantom. Never screenshot this or send it to anyone, Claude included.\n${line}\n`);
console.log(`${s.publicKey.toBase58()} ${t.publicKey.toBase58()}`);')
SERVER=${OUT% *}; TREASURY=${OUT#* }
read -rp "Saved both private keys? Type YES (anything else: nothing changes): " ok
{ clear 2>/dev/null || true; printf '\033[3J'; }
[ "$ok" = YES ] || { echo "Not confirmed. Nothing changed."; exit 1; }

# 3. swap them in: the old keys are kept aside, the server wallet gets one copy per worker
if [ -n "$OLD" ] || [ -s "$TFILE" ]; then
  ARCH="$(dirname "$KEYS")/keys-old-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$ARCH" && chmod 700 "$ARCH"
  [ -z "$OLD" ] || mv $OLD "$ARCH"/
  [ ! -s "$TFILE" ] || mv "$TFILE" "$ARCH"/
fi
mkdir -p "$KEYS"
for n in platform-fee:bf-fee buyback:bf-buyback distributor:bf-payout; do
  install -m 400 -o "${n#*:}" -g root "$TMP/server.json" "$KEYS/${n%%:*}.json"
done
chmod 711 "$KEYS"
echo "$TREASURY" > "$TFILE" && chmod 644 "$TFILE"
echo two > "$LAYOUT"
for k in BUYBACK_PUBKEY DISTRIBUTOR_PUBKEY PLATFORM_FEE_PUBKEY; do setenv common.env "$k" "$SERVER"; done
setenv common.env TREASURY_PUBKEY "$TREASURY"
sed -i '/^PLATFORM_ADMIN_KEYPAIR_PATH=/d' "$LIVE/scripts.env"
setenv scripts.env PLATFORM_ADMIN_PUBKEY "$TREASURY"

echo "Done. Private keys cleared from the screen."
echo
printf 'treasury        %s   (your profit, owner of the platform; key only with you)\n' "$TREASURY"
printf 'server wallet   %s   (send SOL here)\n' "$SERVER"
[ -z "${ARCH:-}" ] || echo "old key files kept in $ARCH"
