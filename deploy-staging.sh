#!/bin/bash
set -e

# Staging deploy — runs from the isolated staging checkout. Adjust the path if you
# clone the staging copy somewhere else (and update DEPLOY_SCRIPT_STAGING to match).
cd /home/ubuntu/backend-staging

# Discard local changes and pull the staging branch. Ignored files (.env, keys/*.pem)
# are preserved — `git clean -df` does NOT remove gitignored files.
git reset --hard
git clean -df
git pull origin staging

npm install

# Start on first deploy, reload afterwards (zero-downtime). Uses staging PM2 names/env.
pm2 startOrReload ecosystem.staging.config.js --update-env
