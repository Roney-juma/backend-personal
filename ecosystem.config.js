module.exports = {
  apps: [
    {
      name: 'app',
      script: 'src/app.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'worker',
      script: 'src/worker.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: 'production', REDIS_URL: 'redis://localhost:6379' },
    },
  ],
};
