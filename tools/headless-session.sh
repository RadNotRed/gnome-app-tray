#!/usr/bin/bash

set -Eeuo pipefail

repo_dir=$1
wayland_name="gnome-app-tray-test-$$"
shell_log="$XDG_CACHE_HOME/gnome-shell.log"
mock_log="$XDG_CACHE_HOME/mock-indicators.log"
prefs_log="$XDG_CACHE_HOME/preferences.log"
shell_pid=''
mock_pid=''
prefs_pid=''
grid_mock_pids=()

cleanup() {
  if [[ -n "$prefs_pid" ]] && kill -0 "$prefs_pid" 2>/dev/null; then
    kill -TERM "$prefs_pid" 2>/dev/null || true
    wait "$prefs_pid" 2>/dev/null || true
  fi
  if [[ -n "$mock_pid" ]] && kill -0 "$mock_pid" 2>/dev/null; then
    kill -TERM "$mock_pid" 2>/dev/null || true
    wait "$mock_pid" 2>/dev/null || true
  fi
  for pid in "${grid_mock_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [[ -n "$shell_pid" ]] && kill -0 "$shell_pid" 2>/dev/null; then
    kill -TERM "$shell_pid" 2>/dev/null || true
    wait "$shell_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

G_MESSAGES_DEBUG='GNOME Shell' \
  SHELL_DEBUG='backtrace-warnings,backtrace-segfaults' \
  gnome-shell \
  --headless \
  --virtual-monitor 1280x720 \
  --wayland-display "$wayland_name" \
  --no-x11 \
  --unsafe-mode \
  >"$shell_log" 2>&1 &
shell_pid=$!

for _attempt in {1..120}; do
  if gdbus call \
    --session \
    --dest org.gnome.Shell \
    --object-path /org/gnome/Shell \
    --method org.freedesktop.DBus.Peer.Ping \
    >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! kill -0 "$shell_pid" 2>/dev/null; then
  echo 'Headless GNOME Shell exited during startup' >&2
  exit 1
fi

sleep 1

eval_shell() {
  gdbus call \
    --session \
    --dest org.gnome.Shell \
    --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval \
    "$1"
}

# Open the real Libadwaita preferences process in the isolated compositor and
# require its window to appear. This catches runtime-only prefs API mistakes.
GDK_BACKEND=wayland \
  WAYLAND_DISPLAY="$wayland_name" \
  gnome-extensions prefs 'gnome-app-tray@radnotred.dev' \
  >"$prefs_log" 2>&1 &
prefs_pid=$!

prefs_window_expression='global.get_window_actors().map(actor => actor.meta_window.get_title() ?? "").join("|")'
prefs_window_result=''
for _attempt in {1..60}; do
  prefs_window_result=$(eval_shell "$prefs_window_expression" 2>/dev/null || true)
  if [[ "$prefs_window_result" == *'App Tray'* ]]; then
    break
  fi
  sleep 0.1
done

if [[ "$prefs_window_result" != *'App Tray'* ]]; then
  echo "Preferences window did not open: $prefs_window_result" >&2
  cat "$prefs_log" >&2
  exit 1
fi

if rg -q 'JS ERROR|Gjs-CRITICAL|GLib-GObject-CRITICAL' "$prefs_log"; then
  echo 'Preferences process logged a runtime error' >&2
  cat "$prefs_log" >&2
  exit 1
fi

if kill -0 "$prefs_pid" 2>/dev/null; then
  kill -TERM "$prefs_pid" 2>/dev/null || true
  wait "$prefs_pid" 2>/dev/null || true
fi
prefs_pid=''

tray_size_expression='(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); return Main.panel.statusArea["gnome-app-tray@radnotred.dev"]?._entries.size ?? -1; })()'

wait_for_tray_size() {
  local expected_size=$1
  local eval_output

  for _attempt in {1..80}; do
    eval_output=$(eval_shell "$tray_size_expression" 2>/dev/null || true)
    if [[ "$eval_output" == *"'$expected_size'"* ]]; then
      return 0
    fi
    if ! kill -0 "$shell_pid" 2>/dev/null; then
      echo 'Headless GNOME Shell died while waiting for tray state' >&2
      return 1
    fi
    sleep 0.1
  done

  echo "Timed out waiting for tray size $expected_size; last result: $eval_output" >&2
  return 1
}

start_mock() {
  local mock_id=$1
  local lifetime=$2
  local title=${3:-"App Tray Test $mock_id"}

  GDK_BACKEND=wayland \
    WAYLAND_DISPLAY="$wayland_name" \
    python3 "$repo_dir/tools/mock-indicator.py" \
    --id "$mock_id" \
    --title "$title" \
    --delay 0 \
    --lifetime "$lifetime" \
    >>"$mock_log" 2>&1 &
  mock_pid=$!
}

# Render enough simultaneous indicators to exercise wrapping, spacing, fixed
# allocations, and scrolling. An optional screenshot path is useful for manual
# visual QA without changing the logged-in desktop.
for iteration in {1..10}; do
  start_mock "gnome-app-tray-grid-$iteration" 0
  grid_mock_pids+=("$mock_pid")
  mock_pid=''
done
wait_for_tray_size 10

eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; tray.menu.open(); tray._rebuildGrid(); return true; })()' >/dev/null
sleep 0.75

grid_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entries = tray._orderedEntries(); const buttons = entries.map(entry => entry.button); const points = buttons.map(button => button.get_transformed_position().map(Math.round)); const xs = new Set(points.map(([x]) => x)); const ys = new Set(points.map(([, y]) => y)); const fixed = buttons.every(button => button.width === 40 && button.height === 40); const movedId = entries[0].info.panelId; tray._movePanelId(movedId, entries.at(-1).info.panelId); const reordered = tray._orderedEntries().at(-1).info.panelId === movedId; tray._rebuildGrid(); return fixed && xs.size === 4 && ys.size === 3 && reordered ? "grid-ok" : `grid-failed:${fixed}:${xs.size}:${ys.size}:${reordered}`; })()')
if [[ "$grid_result" != *'grid-ok'* ]]; then
  echo "Grid geometry check failed: $grid_result" >&2
  exit 1
fi

if [[ -n "${APP_TRAY_SCREENSHOT_PATH:-}" ]]; then
  mkdir -p -- "$(dirname -- "$APP_TRAY_SCREENSHOT_PATH")"
  screenshot_result=$(gdbus call \
    --session \
    --dest org.gnome.Shell.Screenshot \
    --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot \
    false \
    false \
    "$APP_TRAY_SCREENSHOT_PATH")
  if [[ "$screenshot_result" != *'true'* ]]; then
    echo "Screenshot failed: $screenshot_result" >&2
    exit 1
  fi
fi

eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); Main.panel.statusArea["gnome-app-tray@radnotred.dev"].menu.close(); return true; })()' >/dev/null
for pid in "${grid_mock_pids[@]}"; do
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
done
grid_mock_pids=()
wait_for_tray_size 0

# Launch and remove multiple indicators after both extensions are already active.
for iteration in {1..5}; do
  start_mock "gnome-app-tray-mock-$iteration" 2
  wait_for_tray_size 1
  wait "$mock_pid"
  mock_pid=''
  wait_for_tray_size 0
done

# Exercise activation, the existing AppIndicator-owned menu, and live placement
# rule changes without ever changing the foreign actor's parent.
start_mock 'gnome-app-tray-interaction' 0 'App Tray'
wait_for_tray_size 1

interaction_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entry = [...tray._entries.values()][0]; const parentUntouched = entry.item.get_parent() === entry.item.container; const menuManaged = Main.panel.menuManager._menus.includes(entry.item.menu); const iconSize = entry.button._iconSize; return parentUntouched && menuManaged && iconSize === 20 ? "ownership-ok" : "ownership-failed"; })()')
if [[ "$interaction_result" != *'ownership-ok'* ]]; then
  echo "Interaction ownership check failed: $interaction_result" >&2
  exit 1
fi

# Activation and context menus are separate user actions. Exercise them with
# enough time between calls for the AppIndicator DBus proxy to settle.
eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; tray._activate([...tray._entries.keys()][0], null); return true; })()' >/dev/null
sleep 0.75
focus_result=$(eval_shell 'global.display.focus_window?.get_title() ?? ""')
if [[ "$focus_result" != *'App Tray'* ]]; then
  echo "Left-click focus check failed: $focus_result" >&2
  exit 1
fi

eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const panelId = [...tray._entries.keys()][0]; tray.menu.open(); tray._openContextMenu(panelId, null); const count = tray._contextItems.get_children().length; tray._openContextMenu(panelId, null); return count; })()' >/dev/null
sleep 0.75
context_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entry = [...tray._entries.values()][0]; const inlineOpen = tray.menu.isOpen && tray._contextPanel.visible && tray._contextItems.get_children().length > 0; const foreignClosed = !entry.item.menu.isOpen; return inlineOpen && foreignClosed ? "context-open" : "context-closed"; })()')
if [[ "$context_result" != *'context-open'* ]]; then
  echo "Right-click menu check failed: $context_result" >&2
  exit 1
fi

action_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const action = tray._contextItems.get_children().find(child => child.has_style_class_name?.("gnome-app-tray-context-action")); action?.emit("clicked", 1); return action ? "action-clicked" : "action-missing"; })()')
if [[ "$action_result" != *'action-clicked'* ]]; then
  echo "Inline right-click action was not rendered: $action_result" >&2
  exit 1
fi
sleep 0.5
if ! grep -q 'MOCK_INDICATOR_ACTION id=gnome-app-tray-interaction' "$mock_log"; then
  echo 'Inline right-click action did not reach the application' >&2
  exit 1
fi

context_action_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; return tray.menu.isOpen && tray._contextPanel.visible ? "context-still-open" : "context-closed"; })()')
if [[ "$context_action_result" != *'context-still-open'* ]]; then
  echo "Inline action closed the tray: $context_action_result" >&2
  exit 1
fi

placement_result=$(eval_shell '(async () => { const GLib = (await import("gi://GLib")).default; const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entry = [...tray._entries.values()][0]; tray.settings.set_value("app-rules", new GLib.Variant("a{ss}", {[entry.info.key]: "panel"})); return entry.info.key; })()')
if [[ "$placement_result" != *'sni:gnomeapptrayinteraction'* ]]; then
  echo "Placement rule setup failed: $placement_result" >&2
  exit 1
fi
wait_for_tray_size 0

eval_shell '(async () => { const GLib = (await import("gi://GLib")).default; const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; tray.settings.set_value("app-rules", new GLib.Variant("a{ss}", {"sni:gnomeapptrayinteraction": "overflow"})); return true; })()' >/dev/null
wait_for_tray_size 1

# Remove the app while its context menu is open.
eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const panelId = [...tray._entries.keys()][0]; tray._openContextMenu(panelId, null); return true; })()' >/dev/null
sleep 0.5
kill -TERM "$mock_pid" 2>/dev/null || true
wait "$mock_pid" 2>/dev/null || true
mock_pid=''
wait_for_tray_size 0

# Destroy an indicator by disabling its owning AppIndicator extension. This is
# the exact lifecycle that previously aborted GNOME Shell.
start_mock 'gnome-app-tray-owner-disable' 0
wait_for_tray_size 1

eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); await Main.extensionManager._callExtensionDisable("appindicatorsupport@rgcjonas.gmail.com"); return true; })()' >/dev/null
wait_for_tray_size 0

if ! kill -0 "$shell_pid" 2>/dev/null; then
  echo 'Headless GNOME Shell crashed when AppIndicator was disabled' >&2
  exit 1
fi

eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); await Main.extensionManager._callExtensionEnable("appindicatorsupport@rgcjonas.gmail.com"); return true; })()' >/dev/null
kill -TERM "$mock_pid" 2>/dev/null || true
wait "$mock_pid" 2>/dev/null || true
mock_pid=''

# Exercise our own full teardown and recreation repeatedly in the same Shell.
toggle_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); for (let i = 0; i < 20; i++) { await Main.extensionManager._callExtensionDisable("gnome-app-tray@radnotred.dev"); await Main.extensionManager._callExtensionEnable("gnome-app-tray@radnotred.dev"); } return Boolean(Main.panel.statusArea["gnome-app-tray@radnotred.dev"]); })()')
if [[ "$toggle_result" != *"'true'"* ]]; then
  echo "Extension toggle stress failed: $toggle_result" >&2
  exit 1
fi

if rg -q 'Clutter:ERROR|Gjs-CRITICAL|GLib-GObject-CRITICAL|\[AppTray\].*Failed|Extension gnome-app-tray@radnotred.dev.*ERROR' "$shell_log"; then
  echo 'GNOME Shell logged a tray lifecycle error' >&2
  rg -n -C 4 'Clutter:ERROR|Gjs-CRITICAL|GLib-GObject-CRITICAL|\[AppTray\].*Failed|Extension gnome-app-tray@radnotred.dev.*ERROR' "$shell_log" >&2
  exit 1
fi

eval_shell 'global.context.terminate(); true' >/dev/null 2>&1 || true
wait "$shell_pid"
shell_pid=''

echo 'HEADLESS_INTEGRATION_OK'
