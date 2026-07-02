#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${1:-data/crypto_screener.sqlite3}"
REMOTE_DB_PATH="${CRYPTO_SCREENER_DB_PATH:-/data/crypto_screener.sqlite3}"
CHUNK_SIZE="${RAILWAY_SYNC_CHUNK_SIZE:-50000}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "SQLite file not found: $DB_PATH" >&2
  exit 1
fi

quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

remote_dir="$(dirname "$REMOTE_DB_PATH")"
remote_tmp_base="${REMOTE_DB_PATH}.upload.$$"
remote_b64="${remote_tmp_base}.b64"
remote_tmp_db="${remote_tmp_base}.tmp"

railway ssh "mkdir -p $(quote "$remote_dir") && rm -f $(quote "$remote_b64") $(quote "$remote_tmp_db")"

gzip -c "$DB_PATH" | base64 | tr -d '\n' | fold -w "$CHUNK_SIZE" | while IFS= read -r chunk || [[ -n "$chunk" ]]; do
  railway ssh "printf %s $(quote "$chunk") >> $(quote "$remote_b64")"
done

railway ssh "\
  base64 -d $(quote "$remote_b64") | gzip -dc > $(quote "$remote_tmp_db") && \
  python -c \"import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); result = conn.execute('pragma quick_check').fetchone()[0]; conn.close(); raise SystemExit(0 if result == 'ok' else 1)\" $(quote "$remote_tmp_db") && \
  mv $(quote "$remote_tmp_db") $(quote "$REMOTE_DB_PATH") && \
  rm -f $(quote "$remote_b64")"

echo "Synced $DB_PATH to Railway:$REMOTE_DB_PATH"
