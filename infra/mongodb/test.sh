#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
project=urumi-identity-integration
compose=(docker compose -p "$project" -f infra/mongodb/compose.integration.yaml)
trap '"${compose[@]}" down' EXIT
"${compose[@]}" up -d --wait --wait-timeout 90
export MONGODB_TEST_URI='mongodb://127.0.0.1:27417/urumi_test?replicaSet=urumi&directConnection=true'
export MONGODB_STANDALONE_TEST_URI='mongodb://127.0.0.1:27418/urumi_test?directConnection=true'
export MONGODB_TEST_CONTAINER="$("${compose[@]}" ps -q replica)"
pnpm --filter @urumi/gateway build
pnpm --filter @urumi/gateway test
