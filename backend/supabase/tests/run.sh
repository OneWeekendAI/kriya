#!/usr/bin/env bash
# Schema test runner: spins up a throwaway Postgres, applies the Supabase
# runtime stub + the real migration, runs the test suite, tears down.
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER=kriya-schema-test
docker rm -f $CONTAINER >/dev/null 2>&1 || true
docker run -d --name $CONTAINER -e POSTGRES_PASSWORD=test postgres:16 >/dev/null
trap "docker rm -f $CONTAINER >/dev/null" EXIT

echo "waiting for postgres..."
for i in $(seq 1 30); do
  docker exec $CONTAINER pg_isready -U postgres -q && break
  sleep 1
done

run_sql() {
  docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -q -f - < "$1"
}

run_sql 00_stub.sql
run_sql ../migrations/0001_init.sql
docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -f - < 10_tests.sql
