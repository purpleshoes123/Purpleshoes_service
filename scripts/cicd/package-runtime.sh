#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(node --version)" = v22.23.3
test "$(uname -m)" = x86_64
test ! -e output/cicd/runtime
mkdir -p output/cicd/runtime
node scripts/cicd/stage-runtime.mjs
cd apps/bta-proxy
npm run build
cp -a build ../../output/cicd/runtime/build
cd ../../output/cicd/runtime
npm ci --omit=dev --workspaces=false --ignore-scripts --no-fund
node node_modules/prisma/build/index.js generate
node -e "require('sharp'); require('@prisma/client'); console.log('Production native dependencies load')"
cd ../../..
node scripts/cicd/archive-runtime.mjs
