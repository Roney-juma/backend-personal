#!/bin/bash

# Navigate to the app directory
cd /home/ubuntu/ave_backend

# Stash any uncommitted changes (if any)
git reset --hard
git clean -df
git pull origin production

# Install dependencies
npm install --production

# Restart the app using PM2
pm2 restart app
