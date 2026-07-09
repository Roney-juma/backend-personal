// PM2 config for the STAGING deployment. Runs from the staging checkout
// (/home/ubuntu/backend-staging) with distinct process names so it never touches the
// production `app`/`worker`. All other config (PORT, MONGO_URI, REDIS_URL, CORS, keys)
// comes from that directory's own .env — see the staging setup runbook.
module.exports = {
  apps: [
    {
      name: 'app-staging',
      script: 'src/app.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: 'staging' },
    },
    {
      name: 'worker-staging',
      script: 'src/worker.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: 'staging' },
    },
  ],
};
