/**
 * PM2 process file for the Hostinger VPS (SPEC §12). One process per app/worker.
 *   pm2 start ecosystem.config.js && pm2 save
 * Reads secrets from /etc/backflow/backflow.env (not from the repo).
 */
const ENV_FILE = process.env.BACKFLOW_ENV_FILE || "/etc/backflow/backflow.env";
const tsx = (script, cwd) => ({
  cwd,
  script: "node_modules/.bin/tsx",
  args: `--env-file=${ENV_FILE} ${script}`,
  max_memory_restart: "512M",
  restart_delay: 3000,
  exp_backoff_restart_delay: 200,
  time: true,
});

module.exports = {
  apps: [
    { name: "web", cwd: "apps/web", script: "node_modules/.bin/next", args: "start -p 3000", env: { NODE_ENV: "production" }, max_memory_restart: "768M", time: true },
    { name: "api", ...tsx("src/server.ts", "apps/api"), env: { NODE_ENV: "production" } },
    { name: "indexer", ...tsx("src/indexer.ts", "apps/workers") },
    { name: "buyback", ...tsx("src/buyback.ts", "apps/workers") },
    { name: "payout", ...tsx("src/payout.ts", "apps/workers") },
    { name: "harvest", ...tsx("src/harvest.ts", "apps/workers") },
    { name: "reconcile", ...tsx("src/reconcile.ts", "apps/workers") },
  ],
};
