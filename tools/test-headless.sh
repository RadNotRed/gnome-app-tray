#!/usr/bin/bash

set -Eeuo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
test_root=$(mktemp -d "$XDG_RUNTIME_DIR/gnome-app-tray-test.XXXXXX")

cleanup() {
  # GNOME starts a few session helpers that can briefly recreate cache files
  # while the private DBus session is shutting down. Retry this test-only path
  # so a harmless cleanup race does not turn a successful extension test red.
  for _attempt in {1..20}; do
    rm -rf -- "$test_root" 2>/dev/null || true
    [[ ! -e "$test_root" ]] && return
    sleep 0.1
  done

  echo "Could not fully remove test directory: $test_root" >&2
}
trap cleanup EXIT INT TERM

mkdir -p \
  "$test_root/cache" \
  "$test_root/config/glib-2.0/settings" \
  "$test_root/data/gnome-shell/extensions"

ln -s "$repo_dir" \
  "$test_root/data/gnome-shell/extensions/gnome-app-tray@radnotred.dev"

export XDG_CACHE_HOME="$test_root/cache"
export XDG_CONFIG_HOME="$test_root/config"
export XDG_DATA_HOME="$test_root/data"
export XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export GSETTINGS_BACKEND=keyfile

gsettings set org.gnome.shell enabled-extensions \
  "['appindicatorsupport@rgcjonas.gmail.com', 'gnome-app-tray@radnotred.dev']"

glib-compile-schemas --strict "$repo_dir/schemas"

set +e
timeout --signal=TERM --kill-after=5s 75s \
  dbus-run-session -- \
  "$repo_dir/tools/headless-session.sh" "$repo_dir" \
  >"$XDG_CACHE_HOME/test-session.log" 2>&1
test_exit=$?
set -e

if (( test_exit != 0 )); then
  echo "Headless integration test failed with exit $test_exit" >&2
  tail -n 160 "$XDG_CACHE_HOME/test-session.log" >&2
  if [[ -f "$XDG_CACHE_HOME/gnome-shell.log" ]]; then
    tail -n 160 "$XDG_CACHE_HOME/gnome-shell.log" >&2
  fi
  exit "$test_exit"
fi

if ! rg -q '^HEADLESS_INTEGRATION_OK$' "$XDG_CACHE_HOME/test-session.log"; then
  echo 'Headless integration test ended without its success marker' >&2
  tail -n 160 "$XDG_CACHE_HOME/test-session.log" >&2
  exit 1
fi

echo 'HEADLESS_INTEGRATION_OK'
