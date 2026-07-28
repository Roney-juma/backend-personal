#!/bin/bash

# Navigate to the app directory
cd /home/ubuntu/ave_backend

# Stash any uncommitted changes (if any)
git reset --hard
git clean -df
git pull origin production

# Install dependencies
npm install --production

# Start (first deploy) or zero-downtime reload of BOTH the app and the worker.
# Using the ecosystem file ensures the `worker` process is always running — it is
# what actually sends queued emails, push, and WhatsApp. A plain `pm2 restart app`
# leaves the worker unmanaged, so queued emails (e.g. password reset) never send.
pm2 startOrReload ecosystem.config.js --update-env
pm2 save
