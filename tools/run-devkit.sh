#!/usr/bin/bash

set -Eeuo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
runtime_parent=${XDG_RUNTIME_DIR:-/tmp}

if ! gnome-shell --help 2>&1 | rg -q -- '--devkit'; then
  echo 'This GNOME Shell build does not provide development-kit mode.' >&2
  exit 2
fi

if command -v rpm >/dev/null && ! rpm -q mutter-devkit >/dev/null 2>&1; then
  echo 'The Mutter development kit is not installed.' >&2
  echo 'On Fedora, install it with: sudo dnf install mutter-devkit' >&2
  echo 'The automated headless suite remains available with: npm run test:headless' >&2
  exit 2
fi

dev_root=$(mktemp -d "$runtime_parent/gnome-app-tray-devkit.XXXXXX")

cleanup() {
  for _attempt in {1..20}; do
    rm -rf -- "$dev_root" 2>/dev/null || true
    [[ ! -e "$dev_root" ]] && return
    sleep 0.1
  done
}
trap cleanup EXIT INT TERM

mkdir -p \
  "$dev_root/cache" \
  "$dev_root/config/glib-2.0/settings" \
  "$dev_root/data/gnome-shell/extensions"

ln -s "$repo_dir" \
  "$dev_root/data/gnome-shell/extensions/gnome-app-tray@radnotred.dev"

export XDG_CACHE_HOME="$dev_root/cache"
export XDG_CONFIG_HOME="$dev_root/config"
export XDG_DATA_HOME="$dev_root/data"
export XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export GSETTINGS_BACKEND=keyfile

gsettings set org.gnome.shell enabled-extensions \
  "['appindicatorsupport@rgcjonas.gmail.com', 'gnome-app-tray@radnotred.dev']"
glib-compile-schemas --strict "$repo_dir/schemas"

echo 'Opening an isolated GNOME Shell development window.'
echo 'Close and rerun this command after JavaScript changes; GNOME caches loaded modules.'
dbus-run-session -- gnome-shell --wayland --devkit
