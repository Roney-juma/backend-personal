// PM2 process definition (single-host / EC2 deploys).
//
// `app` runs in CLUSTER mode across all CPU cores for per-core resilience and
// throughput; `worker` runs as a single fork (BullMQ distributes jobs, so scale
// workers by running more hosts/tasks, not more forks on one box).
//
// NOTE: REDIS_URL / MONGO_URI are intentionally NOT hardcoded here — they come
// from the host environment (systemd unit, ECS task def, or a .env). Hardcoding
// REDIS_URL=localhost would silently override the ElastiCache endpoint in prod.
module.exports = {
  apps: [
    {
      name: 'app',
      script: 'src/app.js',
      cwd: __dirname,
      instances: process.env.WEB_CONCURRENCY || 'max',
      exec_mode: 'cluster',
      autorestart: true,
      max_memory_restart: '512M',
      watch: false,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'worker',
      script: 'src/worker.js',
      cwd: __dirname,
      instances: Number(process.env.WORKER_CONCURRENCY) || 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      watch: false,
      env: { NODE_ENV: 'production' },
    },
  ],
};
