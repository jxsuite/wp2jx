#!/usr/bin/env bash
# Throwaway MariaDB for developing against a WordPress dump.
#
#   scripts/dev-db.sh start              start the server (TCP 127.0.0.1:${WP2JX_DB_PORT:-3399}, root, no password)
#   scripts/dev-db.sh import <db> <sql>  create <db> and load a mysqldump into it
#   scripts/dev-db.sh stop               stop the server
#   scripts/dev-db.sh url <db>           print the --db URL
#
# State lives in .dev/db (gitignored). A site's own wordpress-nix devenv with
# `database.type = "mysql"` works just as well: wp2jx only needs a mysql:// URL.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${WP2JX_DB_PORT:-3399}"
DIR="$PWD/.dev/db"
run() { nix shell nixpkgs#mariadb -c "$@"; }

case "${1:-}" in
  start)
    mkdir -p "$DIR"
    if [ ! -d "$DIR/data/mysql" ]; then
      run mariadb-install-db --no-defaults --datadir="$DIR/data" --auth-root-authentication-method=normal --skip-test-db >"$DIR/install.log" 2>&1
    fi
    if run mariadb-admin --no-defaults -h127.0.0.1 -P"$PORT" -uroot ping >/dev/null 2>&1; then echo "already running on $PORT"; exit 0; fi
    nohup nix shell nixpkgs#mariadb -c mariadbd --no-defaults --datadir="$DIR/data" --port="$PORT" --bind-address=127.0.0.1 \
      --socket="$DIR/mysql.sock" --pid-file="$DIR/mysql.pid" --max-allowed-packet=256M --innodb-buffer-pool-size=512M \
      --skip-log-bin >"$DIR/server.log" 2>&1 &
    for _ in $(seq 1 60); do
      run mariadb-admin --no-defaults -h127.0.0.1 -P"$PORT" -uroot ping >/dev/null 2>&1 && { echo "up on $PORT"; exit 0; }
      sleep 1
    done
    echo "server did not come up; see $DIR/server.log" >&2; exit 1 ;;
  import)
    db="${2:?db name}"; sql="${3:?dump path}"
    run mariadb --no-defaults -h127.0.0.1 -P"$PORT" -uroot -e "CREATE DATABASE IF NOT EXISTS \`$db\` CHARACTER SET utf8mb4"
    run mariadb --no-defaults -h127.0.0.1 -P"$PORT" -uroot --max-allowed-packet=256M "$db" <"$sql"
    echo "imported $sql into $db" ;;
  stop)
    [ -f "$DIR/mysql.pid" ] && kill "$(cat "$DIR/mysql.pid")" && echo stopped || echo "not running" ;;
  url) echo "mysql://root@127.0.0.1:$PORT/${2:?db name}" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
