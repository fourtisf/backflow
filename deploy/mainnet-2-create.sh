#!/bin/bash
# Mainnet phase 2: create Rebuy's platform on mainnet (docs/MAINNET.md, DECISIONS.md D-043, D-044).
#   sudo bash /opt/backflow/deploy/mainnet-2-create.sh
# Sends real transactions. Each one is dry-run first and only sent after you type YES:
#   1. split the SOL you sent to the server wallet (platform fee wallet) to the admin, buyback and distributor;
#   2. create the LaunchLab platform (paid by the admin wallet);
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
op() { (set -a; . "$LIVE/common.env"; . "$LIVE/scripts.env"; set +a; cd "$APP" && pnpm --silent "$@") 2>&1 | grep -v '^bigint: Failed to load bindings' || true; }
[ -z "${OP_STUB:-}" ] || op() { bash "$OP_STUB" "$@"; }   # tests only
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
  out=$(op platform:create); echo "$out"
  if grep -q 'differ from config' <<<"$out"; then echo "The platform on chain differs from config/fees.json. Stopping."; exit 1; fi
  if grep -q 'Dry run. Nothing was sent' <<<"$out"; then
    yes_or_stop "Create the Rebuy platform on mainnet with the values above (about 0.01 SOL)?"
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
