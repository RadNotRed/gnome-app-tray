#!/usr/bin/bash

set -Eeuo pipefail

stable_uuid='gnome-app-tray@radnotred.dev'
dev_uuid_prefix='gnome-app-tray-dev-'
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
runtime_parent=${XDG_RUNTIME_DIR:-/tmp}
state_dir="$runtime_parent/gnome-app-tray-host-dev-$UID"
state_file="$state_dir/current-uuid"
user_data_home=${XDG_DATA_HOME:-$(python3 -c 'from gi.repository import GLib; print(GLib.get_user_data_dir())')}
extension_root="$user_data_home/gnome-shell/extensions"
mode='hold'
build_root=''
unsafe_mode_granted=false

case "${1:-}" in
  '') ;;
  --once) mode='once' ;;
  --stop) mode='stop' ;;
  *)
    echo "Usage: $0 [--once|--stop]" >&2
    exit 2
    ;;
esac

cleanup_build() {
  if [[ -n "$build_root" && "$build_root" == "$runtime_parent"/gnome-app-tray-host-build.* ]]; then
    rm -rf -- "$build_root"
  fi
}

disable_unsafe_mode() {
  if [[ "$unsafe_mode_granted" != true ]]; then
    return
  fi

  if [[ "${GNOME_APP_TRAY_DEV_KEEP_UNSAFE:-0}" == 1 ]]; then
    unsafe_mode_granted=false
    return
  fi

  gdbus call \
    --session \
    --dest org.gnome.Shell \
    --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval \
    'global.context.unsafe_mode = false; true' \
    >/dev/null 2>&1 || true
  unsafe_mode_granted=false
}

cleanup_after_run() {
  disable_unsafe_mode
  cleanup_build
}

dev_extensions() {
  local uuid
  while IFS= read -r uuid; do
    if [[ "$uuid" == "$dev_uuid_prefix"*'@radnotred.dev' ]]; then
      printf '%s\n' "$uuid"
    fi
  done < <(gnome-extensions list 2>/dev/null || true)
}

stop_dev_extensions() {
  local uuid
  while IFS= read -r uuid; do
    [[ -n "$uuid" ]] || continue
    gnome-extensions disable "$uuid" >/dev/null 2>&1 || true
    gnome-extensions uninstall "$uuid" >/dev/null 2>&1 || true
  done < <(dev_extensions)

  # A failed registration can leave a copied bundle that the running Shell
  # does not know about. Only remove directories in our private UUID namespace.
  if [[ -d "$extension_root" ]]; then
    while IFS= read -r -d '' path; do
      if [[ "$path" == "$extension_root"/"$dev_uuid_prefix"*'@radnotred.dev' ]]; then
        rm -rf -- "$path"
      fi
    done < <(
      find "$extension_root" \
        -mindepth 1 \
        -maxdepth 1 \
        -type d \
        -name "$dev_uuid_prefix*@radnotred.dev" \
        -print0
    )
  fi

  python3 - "$dev_uuid_prefix" <<'PY'
import sys

from gi.repository import Gio

prefix = sys.argv[1]
settings = Gio.Settings.new("org.gnome.shell")
for key in ("enabled-extensions", "disabled-extensions"):
    current = settings.get_strv(key)
    filtered = [
        uuid
        for uuid in current
        if not (uuid.startswith(prefix) and uuid.endswith("@radnotred.dev"))
    ]
    if filtered != current:
        settings.set_strv(key, filtered)
Gio.Settings.sync()
PY

  rm -f -- "$state_file"
}

if [[ "$mode" == 'stop' ]]; then
  stop_dev_extensions
  echo 'Stopped and removed App Tray host-development copies.'
  exit 0
fi

eval_result=$(gdbus call \
  --session \
  --dest org.gnome.Shell \
  --object-path /org/gnome/Shell \
  --method org.gnome.Shell.Eval \
  '1 + 1' 2>/dev/null || true)

if [[ "$eval_result" != '(true,'* ]]; then
  cat >&2 <<'EOF'
GNOME must temporarily allow its developer evaluator to register a fresh UUID.

1. Press Alt+F2 and enter: lg
2. Open the Evaluator tab.
3. Run: global.context.unsafe_mode = true
4. Close Looking Glass and run npm run dev:host again.

The launcher turns unsafe mode off immediately after loading the temporary copy.
EOF
  exit 2
fi
unsafe_mode_granted=true
trap cleanup_after_run EXIT

# The stable UUID may already have its old JavaScript cached. Keep it disabled
# and remove only our own temporary development copies before making a fresh one.
gnome-extensions disable "$stable_uuid" >/dev/null 2>&1 || true
stop_dev_extensions

timestamp=$(date +%Y%m%d%H%M%S)
dev_uuid="$dev_uuid_prefix$timestamp-$BASHPID@radnotred.dev"
build_root=$(mktemp -d "$runtime_parent/gnome-app-tray-host-build.XXXXXX")
source_dir="$build_root/source"
mkdir -p "$source_dir" "$state_dir"

cp -a \
  "$repo_dir/extension.js" \
  "$repo_dir/prefs.js" \
  "$repo_dir/stylesheet.css" \
  "$repo_dir/metadata.json" \
  "$repo_dir/lib" \
  "$repo_dir/schemas" \
  "$source_dir/"

node - "$source_dir/metadata.json" "$dev_uuid" <<'NODE'
const fs = require('node:fs');
const [metadataPath, uuid] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
metadata.uuid = uuid;
metadata.name = 'App Tray (Host Dev)';
metadata.description = 'Temporary cache-busting build of App Tray for host-session testing.';
fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
NODE

(
  cd "$source_dir"
  gnome-extensions pack . \
    --extra-source=lib \
    --extra-source=prefs.js \
    --schema=schemas/org.gnome.shell.extensions.gnome-app-tray.gschema.xml \
    --out-dir="$build_root" \
    --force \
    --quiet
)

bundle="$build_root/$dev_uuid.shell-extension.zip"
installed_uuid=$(gnome-extensions install --force --print-uuid "$bundle")
if [[ "$installed_uuid" != "$dev_uuid" ]]; then
  echo "Installed unexpected extension UUID: $installed_uuid" >&2
  exit 1
fi

installed_path="$extension_root/$dev_uuid"
js_uuid=$(node -p 'JSON.stringify(process.argv[1])' "$dev_uuid")
js_path=$(node -p 'JSON.stringify(process.argv[1])' "$installed_path")
load_result=$(gdbus call \
  --session \
  --dest org.gnome.Shell \
  --object-path /org/gnome/Shell \
  --method org.gnome.Shell.Eval \
  "(async () => { const Gio = (await import('gi://Gio')).default; const Main = await import('resource:///org/gnome/shell/ui/main.js'); const {ExtensionState, ExtensionType} = await import('resource:///org/gnome/shell/misc/extensionUtils.js'); const manager = Main.extensionManager; if (manager.lookup($js_uuid)) return false; const extension = manager.createExtensionObject($js_uuid, Gio.File.new_for_path($js_path), ExtensionType.PER_USER); await manager.loadExtension(extension); if (extension.state === ExtensionState.INITIALIZED) await manager._callExtensionEnable($js_uuid); return extension.state === ExtensionState.ACTIVE; })()" \
  2>/dev/null || true)

if [[ "$load_result" != *"'true'"* ]]; then
  echo "GNOME did not register the temporary extension: $load_result" >&2
  disable_unsafe_mode
  stop_dev_extensions
  exit 1
fi

printf '%s\n' "$dev_uuid" >"$state_file"

disable_unsafe_mode

extension_info=''
for _attempt in {1..50}; do
  extension_info=$(gnome-extensions info "$dev_uuid" 2>&1 || true)
  if [[ "$extension_info" == *'State: ACTIVE'* ]]; then
    break
  fi
  sleep 0.1
done

if [[ "$extension_info" != *'State: ACTIVE'* ]]; then
  echo 'The host-development extension did not become active:' >&2
  echo "$extension_info" >&2
  gdbus call \
    --session \
    --dest org.gnome.Shell \
    --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Extensions.GetExtensionErrors \
    "$dev_uuid" \
    >&2 || true
  stop_dev_extensions
  exit 1
fi

echo "Loaded fresh App Tray code as: $dev_uuid"
echo 'This copy uses your current applications and existing App Tray settings.'

if [[ "$mode" == 'once' ]]; then
  echo 'It will remain active. Run npm run dev:host:stop when finished.'
  exit 0
fi

echo 'Leave this command running while testing. Press Ctrl+C to remove the temporary copy.'
trap 'stop_dev_extensions; cleanup_after_run' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

while true; do
  sleep 10
done
