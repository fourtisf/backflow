/**
 * PM2 process file for the Hostinger VPS (SPEC §12). One process per app/worker.
 *   pm2 start ecosystem.config.js && pm2 save
 *
 * Key isolation (audit M6, docs/DEPLOY.md §3): every process reads a shared, key-free
 * /etc/backflow/common.env plus its own /etc/backflow/<name>.env (Node supports several
 * --env-file flags; the later file wins). Only the buyback, payout, harvest and reconcile
 * files name a keypair path, and each names only the key that process signs with:
 *   indexer   -> none
 *   buyback   -> BUYBACK_WALLET_KEYPAIR_PATH
 *   payout    -> DISTRIBUTOR_WALLET_KEYPAIR_PATH
 *   harvest   -> PLATFORM_FEE_WALLET_KEYPAIR_PATH
 *   reconcile -> PLATFORM_FEE_WALLET_KEYPAIR_PATH
 *   api       -> none (public keys only, plus VANITY_KEY)
 *   web       -> only web.env (it never sees common.env)
 * PLATFORM_ADMIN_KEYPAIR_PATH belongs to operator scripts only, never to a PM2 env file.
 *
 * With BACKFLOW_SPLIT_USERS=1 (PM2 started as root), each process also runs as its own Unix
 * user, so a worker can't read another worker's key file (see DEPLOY.md for the users).
 */
const ENV_DIR = process.env.BACKFLOW_ENV_DIR || "/etc/backflow";
const SPLIT = process.env.BACKFLOW_SPLIT_USERS === "1";

const envArgs = (name, { common = true } = {}) => [...(common ? [`--env-file=${ENV_DIR}/common.env`] : []), `--env-file=${ENV_DIR}/${name}.env`];
const user = (name) => (SPLIT ? { uid: name, gid: name } : {});

// With pnpm, node_modules/.bin/* are shell wrappers, and PM2 runs `script` with Node, so point at the
// packages' JavaScript entry points instead. The env files are loaded by Node (node_args) before tsx starts.
const tsx = (name, script, cwd, unixUser) => ({
  name,
  cwd,
  script: "node_modules/tsx/dist/cli.mjs",
  args: script,
  node_args: envArgs(name),
  max_memory_restart: "512M",
  restart_delay: 3000,
  exp_backoff_restart_delay: 200,
  time: true,
  ...user(unixUser),
});

module.exports = {
  apps: [
    {
      name: "web",
      cwd: "apps/web",
      script: "node_modules/next/dist/bin/next",
      // loopback only: Nginx is the way in (audit L5)
      args: "start -H 127.0.0.1 -p 3000",
      node_args: envArgs("web", { common: false }),
      env: { NODE_ENV: "production" },
      max_memory_restart: "768M",
      time: true,
      // the code owner: Next writes its cache under .next/, and this user holds no key and no common.env
      ...user("backflow"),
    },
    { ...tsx("api", "src/server.ts", "apps/api", "bf-api"), env: { NODE_ENV: "production" } },
    { ...tsx("indexer", "src/indexer.ts", "apps/workers", "bf-indexer"), env: { NODE_ENV: "production" } },
    { ...tsx("buyback", "src/buyback.ts", "apps/workers", "bf-buyback"), env: { NODE_ENV: "production" } },
    { ...tsx("payout", "src/payout.ts", "apps/workers", "bf-payout"), env: { NODE_ENV: "production" } },
    // harvest and reconcile both sign with the platform fee wallet, so they share one user
    { ...tsx("harvest", "src/harvest.ts", "apps/workers", "bf-fee"), env: { NODE_ENV: "production" } },
    { ...tsx("reconcile", "src/reconcile.ts", "apps/workers", "bf-fee"), env: { NODE_ENV: "production" } },
  ],
};
