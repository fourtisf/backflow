#!/bin/bash
# Mainnet phase 2: create Rebuy's platform on mainnet (docs/MAINNET.md, DECISIONS.md D-043, D-044).
#   sudo bash /opt/backflow/deploy/mainnet-2-create.sh
# Sends real transactions. Each one is dry-run first and only sent after you type YES:
#   1. from the SOL you sent to the server wallet, top up the wallet that pays for creating the platform
#      (the treasury with two wallets, D-045; the admin wallet otherwise) and any separate worker wallets;
#   2. create the LaunchLab platform (with two wallets, you paste the treasury key once; it is not saved);
#   3. create the address lookup table (paid by the server wallet);
#   4. save PLATFORM_CONFIG_PUBKEY, CP_CONFIG_ID and BACKFLOW_ALT in /etc/backflow-live/common.env;
#   5. offer to remove the admin key from this server (you keep the copy from show-keys.sh).
# Safe to run again: finished steps are skipped. The site stays on the demo until phase 3.
set -euo pipefail
APP=${APP:-/opt/backflow}
LIVE=${LIVE:-/etc/backflow-live}
KEYS=${KEYS:-/etc/backflow/keys}
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
[ -f "$LIVE/common.env" ] && [ -f "$LIVE/scripts.env" ] || { echo "Run deploy/mainnet-1-prepare.sh first."; exit 1; }

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
op() { (set -a; . "$LIVE/common.env"; . "$LIVE/scripts.env"; [ -z "${ADMIN_KP:-}" ] || PLATFORM_ADMIN_KEYPAIR_PATH=$ADMIN_KP; set +a; cd "$APP" && pnpm --silent "$@") 2>&1 | grep -v '^bigint: Failed to load bindings' || true; }
[ -z "${OP_STUB:-}" ] || op() { ADMIN_KP="${ADMIN_KP:-}" bash "$OP_STUB" "$@"; }   # tests only
cur() { { grep -m1 "^$1=" "$LIVE/common.env" || true; } | cut -d= -f2-; }
setenv() { if grep -q "^$1=" "$LIVE/common.env"; then sed -i "s|^$1=.*|$1=$2|" "$LIVE/common.env"; else echo "$1=$2" >> "$LIVE/common.env"; fi; }
yes_or_stop() { local a; read -rp "$1 Type YES to send: " a; [ "$a" = YES ] || { echo "Stopped. Nothing more was sent."; exit 1; }; }

say "1/4 Server wallets"
out=$(op wallets:fund); echo "$out"
if grep -q 'Not enough SOL' <<<"$out"; then exit 1; fi
if grep -q 'Re-run with --send' <<<"$out"; then
  yes_or_stop "Make the transfers above?"
  out=$(op wallets:fund --send); echo "$out"
  grep -q '^sent: ' <<<"$out" || { echo "The transfers were not confirmed. Run this script again."; exit 1; }
elif ! grep -q 'Nothing to send' <<<"$out"; then
  echo "Couldn't read the wallet balances (see above). Nothing was sent."; exit 1
fi

say "2/4 Platform"
if [ -n "$(cur PLATFORM_CONFIG_PUBKEY)" ]; then
  echo "already created: $(cur PLATFORM_CONFIG_PUBKEY)"
else
  # Two wallets (D-045): the treasury owns the platform and its key is not on this server. It is asked for
  # once here, kept in memory-backed /dev/shm for the next two commands and shredded on exit.
  ADMIN_PUB=$({ grep -m1 '^PLATFORM_ADMIN_PUBKEY=' "$LIVE/scripts.env" || true; } | cut -d= -f2-)
  ADMIN_PATH=$({ grep -m1 '^PLATFORM_ADMIN_KEYPAIR_PATH=' "$LIVE/scripts.env" || true; } | cut -d= -f2-)
  if [ -n "$ADMIN_PUB" ] && { [ -z "$ADMIN_PATH" ] || [ ! -f "$ADMIN_PATH" ]; }; then
    TMP=$(mktemp -d /dev/shm/rebuy.XXXXXX 2>/dev/null || mktemp -d); chmod 700 "$TMP"
    trap 'shred -u "$TMP"/* 2>/dev/null || true; rmdir "$TMP" 2>/dev/null || true' EXIT
    echo "The treasury owns the platform, so its private key signs this once. It is not saved."
    read -rsp "Treasury private key ($ADMIN_PUB): " TK; echo
    printf '%s' "$TK" | (cd "$APP/packages/chain" && OUTF="$TMP/admin.json" WANT="$ADMIN_PUB" node -e '
        const fs = require("fs"), { Keypair } = require("@solana/web3.js"), b = require("bs58"), e = b.default || b;
        const raw = fs.readFileSync(0, "utf8").trim();
        let k;
        try { k = Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : e.decode(raw)); } catch { console.log("That is not a private key."); process.exit(2); }
        if (k.publicKey.toBase58() !== process.env.WANT) { console.log(`That key belongs to ${k.publicKey.toBase58()}, not the treasury ${process.env.WANT}.`); process.exit(2); }
        fs.writeFileSync(process.env.OUTF, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });' 2>&1 | grep -v '^bigint: Failed') || true
    unset TK
    [ -f "$TMP/admin.json" ] || { echo "Run this script again and paste the treasury private key."; exit 1; }
    ADMIN_KP="$TMP/admin.json"
  fi
  out=$(op platform:create); echo "$out"
  if grep -q 'differ from config' <<<"$out"; then echo "The platform on chain differs from config/fees.json. Stopping."; exit 1; fi
  if grep -q 'Dry run. Nothing was sent' <<<"$out"; then
    yes_or_stop "Create the Rebuy platform on mainnet with the values above (about 0.0075 SOL, paid by the platform owner)?"
    out=$(op platform:create --send); echo "$out"
    grep -q 'Created and matches config/fees.json' <<<"$out" || { echo "The platform was not created as expected (see above). Run this script again."; exit 1; }
  elif ! grep -q '^PLATFORM_CONFIG_PUBKEY=' <<<"$out"; then
    echo "The dry run did not pass (see above). Nothing was sent."; exit 1
  fi
  P=$(grep -m1 '^PLATFORM_CONFIG_PUBKEY=' <<<"$out" | cut -d= -f2-); C=$(grep -m1 '^CP_CONFIG_ID=' <<<"$out" | cut -d= -f2-)
  [ -n "$P" ] && [ -n "$C" ] || { echo "Couldn't read the platform address. Run this script again."; exit 1; }
  setenv PLATFORM_CONFIG_PUBKEY "$P"; setenv CP_CONFIG_ID "$C"
  echo "saved PLATFORM_CONFIG_PUBKEY and CP_CONFIG_ID"
fi

say "3/4 Address lookup table"
if [ -n "$(cur BACKFLOW_ALT)" ]; then
  echo "already created: $(cur BACKFLOW_ALT)"
else
  out=$(op alt:create); echo "$out"
  grep -q 'Re-run with --send' <<<"$out" || { echo "The dry run did not pass (see above). Nothing was sent."; exit 1; }
  yes_or_stop "Create the lookup table (about 0.01 SOL from the server wallet)?"
  out=$(op alt:create --send); echo "$out"
  A=$(grep -m1 '^BACKFLOW_ALT=' <<<"$out" | cut -d= -f2-)
  [ -n "$A" ] || { echo "The lookup table was not confirmed. Run this script again."; exit 1; }
  setenv BACKFLOW_ALT "$A"
  echo "saved BACKFLOW_ALT"
fi

say "4/4 Check"
op platform:show
if [ -f "$KEYS/platform-admin.json" ]; then
  echo
  echo "The admin key is only needed again to change the platform's fee settings, and you saved a copy with show-keys.sh."
  echo "Removing it from this server means a break-in here can never take over the platform."
  read -rp "Remove the admin key from this server now? Type YES (anything else keeps it): " a
  if [ "$a" = YES ]; then
    shred -u "$KEYS/platform-admin.json"
    sed -i '/^PLATFORM_ADMIN_KEYPAIR_PATH=/d' "$LIVE/scripts.env"
    echo "admin key removed from the server"
  fi
fi

say "Done. Send Claude everything below this line (it holds no secrets)"
printf 'platform        %s\ncpmm tier       %s\nlookup table    %s\n' "$(cur PLATFORM_CONFIG_PUBKEY)" "$(cur CP_CONFIG_ID)" "$(cur BACKFLOW_ALT)"
echo "The site still shows the demo. Phase 3 switches it to live, with buybacks and payouts paused."
