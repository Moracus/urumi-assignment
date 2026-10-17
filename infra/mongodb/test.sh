#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
browser=false
if [[ ${1:-} == --browser && $# == 1 ]]; then
  browser=true
elif [[ $# != 0 ]]; then
  echo 'Usage: infra/mongodb/test.sh [--browser]' >&2
  exit 2
fi
project=urumi-identity-integration
compose=(docker compose -p "$project" -f infra/mongodb/compose.integration.yaml)
trap '"${compose[@]}" down' EXIT
"${compose[@]}" up -d --wait --wait-timeout 90
export MONGODB_TEST_URI='mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true'
export MONGODB_STANDALONE_TEST_URI='mongodb://127.0.0.1:27418/urumi_test?directConnection=true'
export MONGODB_TEST_CONTAINER="$("${compose[@]}" ps -q replica)"
if "$browser"; then
  pnpm typecheck
  pnpm build
else
  pnpm --filter @urumi/gateway build
  pnpm --filter @urumi/woocommerce-mcp build
fi
pnpm --filter @urumi/woocommerce-mcp test
pnpm --filter @urumi/gateway test
# Run after the outage tests have restored MongoDB, while this runner still owns
# the disposable containers. The EXIT trap also handles browser/check failures.
if "$browser"; then
  pnpm --filter @urumi/dashboard test:browser
fi
