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

grid_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entries = tray._orderedEntries(); const buttons = entries.map(entry => entry.button); const points = buttons.map(button => button.get_transformed_position().map(Math.round)); const xs = new Set(points.map(([x]) => x)); const ys = new Set(points.map(([, y]) => y)); const fixed = buttons.every(button => button.width === 40 && button.height === 40); const panelSlotsCollapsed = entries.every(entry => entry.item.container.width === 0 && entry.item.container.get_preferred_width(-1)[1] === 0); const movedId = entries[0].info.panelId; tray._movePanelId(movedId, entries.at(-1).info.panelId); const reordered = tray._orderedEntries().at(-1).info.panelId === movedId; tray._rebuildGrid(); return fixed && panelSlotsCollapsed && xs.size === 4 && ys.size === 3 && reordered ? "grid-ok" : `grid-failed:${fixed}:${panelSlotsCollapsed}:${xs.size}:${ys.size}:${reordered}`; })()')
if [[ "$grid_result" != *'grid-ok'* ]]; then
  echo "Grid geometry check failed: $grid_result" >&2
  exit 1
fi

icon_scale_result=$(eval_shell '(async () => { const GLib = (await import("gi://GLib")).default; const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entry = [...tray._entries.values()][0]; const paddedPixels = Array(8 * 8 * 4).fill(0); for (let y = 0; y < 8; y++) for (let x = 2; x < 6; x++) paddedPixels[(y * 8 + x) * 4] = 255; const paddedPixmap = new GLib.Variant("a(iiay)", [[8, 8, paddedPixels]]); entry.button.sync({...entry.info, sourceIcon: null, indicator: {icon: {pixmap: paddedPixmap}}}, 20); const paddedScaled = entry.button._displayScale === 1 && entry.button._displayWidth === 10 && entry.button._displayHeight === 20 && entry.button._croppedIcon.width === 4; const rectangularPixels = Array(16 * 8 * 4).fill(255); const rectangularPixmap = new GLib.Variant("a(iiay)", [[16, 8, rectangularPixels]]); entry.button.sync({...entry.info, sourceIcon: null, indicator: {icon: {pixmap: rectangularPixmap}}}, 20); const rectangularFitted = entry.button._displayScale === 1 && entry.button._displayWidth === 20 && entry.button._displayHeight === 10 && entry.button._iconBin.width === 20 && entry.button._iconBin.height === 20 && entry.button._iconBin.child.width === 20 && entry.button._iconBin.child.height === 10; const tinyPixels = Array(32 * 32 * 4).fill(0); for (let y = 3; y < 7; y++) for (let x = 20; x < 24; x++) tinyPixels[(y * 32 + x) * 4] = 255; entry.button.sync({...entry.info, sourceIcon: null, indicator: {icon: {pixmap: new GLib.Variant("a(iiay)", [[32, 32, tinyPixels]])}}}, 20); const tinyFitted = entry.button._croppedIcon.width === 4 && entry.button._croppedIcon.height === 4 && entry.button._displayWidth === 20 && entry.button._displayHeight === 20; entry.button.sync(entry.info, 20); const themedSquare = entry.button._displayWidth === 20 && entry.button._displayHeight === 20; return paddedScaled && rectangularFitted && tinyFitted && themedSquare ? "icon-geometry-ok" : `icon-geometry-failed:${paddedScaled}:${rectangularFitted}`; })()')
if [[ "$icon_scale_result" != *'icon-geometry-ok'* ]]; then
  echo "Automatic icon geometry check failed: $icon_scale_result" >&2
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

interaction_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entry = [...tray._entries.values()][0]; const parentUntouched = entry.item.get_parent() === entry.item.container; const menuManaged = Main.panel.menuManager._menus.includes(entry.item.menu); const iconSize = entry.button._iconSize; const [, containerWidth] = entry.item.container.get_preferred_width(-1); const panelSlotCollapsed = entry.item.container.width === 0 && containerWidth === 0; return parentUntouched && menuManaged && iconSize === 20 && panelSlotCollapsed ? "ownership-ok" : "ownership-failed"; })()')
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
dropdown_result=$(eval_shell "(async () => { const Main = await import('resource:///org/gnome/shell/ui/main.js'); const test = await import('file://$repo_dir/tests/context-layout.js'); return test.run(Main.panel.statusArea['gnome-app-tray@radnotred.dev']); })()")
if [[ "$dropdown_result" != *'dropdown-layout-ok'* ]]; then
  echo "Dropdown layout check failed: $dropdown_result" >&2
  exit 1
fi

context_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const adjustment = tray._contextScrollView.get_vadjustment(); return tray.menu.isOpen && tray._contextScrollView.height <= 320 && adjustment.upper > adjustment.page_size ? "context-open" : "context-closed"; })()')
if [[ "$context_result" != *'context-open'* ]]; then
  echo "Right-click menu check failed: $context_result" >&2
  exit 1
fi

if [[ -n "${APP_TRAY_SCREENSHOT_PATH:-}" ]]; then
  gdbus call --session --dest org.gnome.Shell.Screenshot \
    --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot false false \
    "${APP_TRAY_SCREENSHOT_PATH%.png}-menu.png" >/dev/null
  eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; tray._contextItems.get_children().find(child => child.accessible_name === "More actions").emit("clicked", 1); return true; })()' >/dev/null
  sleep 0.1
  gdbus call --session --dest org.gnome.Shell.Screenshot \
    --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot false false \
    "${APP_TRAY_SCREENSHOT_PATH%.png}-collapsed.png" >/dev/null
fi

model_only_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entry = [...tray._entries.values()][0]; const original = entry.item.menu._getMenuItems; try { entry.item.menu._getMenuItems = () => []; tray._clearContextMenu(); tray._openContextMenu(entry.info.panelId, null); return tray._contextItems.get_children().some(child => child.accessible_name === "Mock action") ? "model-only-ok" : "model-only-failed"; } finally { entry.item.menu._getMenuItems = original; } })()')
if [[ "$model_only_result" != *'model-only-ok'* ]]; then
  echo "Unpopulated companion menu check failed: $model_only_result" >&2
  exit 1
fi

menu_session_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entry = [...tray._entries.values()][0]; const sourceItem = entry.item.menu._getMenuItems().find(item => item._dbusItem); const dbusClient = sourceItem?._dbusItem?._client; const active = dbusClient?._active === true; tray._clearContextMenu(); const inactive = dbusClient?._active === false; tray._openContextMenu(entry.info.panelId, null); return active && inactive ? "menu-session-ok" : `menu-session-failed:${active}:${inactive}`; })()')
if [[ "$menu_session_result" != *'menu-session-ok'* ]]; then
  echo "Mirrored menu session check failed: $menu_session_result" >&2
  exit 1
fi

# DBus menu updates are asynchronous and can arrive well after an initial
# AboutToShow round trip. Verify the mirror follows a late property change.
sleep 0.45
eval_shell '(async () => { const GLib = (await import("gi://GLib")).default; const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entry = [...tray._entries.values()][0]; const sourceItem = entry.item.menu._getMenuItems().find(item => item._dbusItem); sourceItem._dbusItem.propertySet("label", GLib.Variant.new_string("Delayed mock action")); return true; })()' >/dev/null
sleep 0.1
delayed_menu_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const action = tray._contextItems.get_children().find(child => child.accessible_name === "Delayed mock action"); return action ? "delayed-menu-ok" : "delayed-menu-stale"; })()')
if [[ "$delayed_menu_result" != *'delayed-menu-ok'* ]]; then
  echo "Delayed menu update was not mirrored: $delayed_menu_result" >&2
  exit 1
fi

# Disable the extension while a live menu refresh is queued, ensuring teardown
# cancels that source exactly once before bulk source cleanup.
pending_refresh_result=$(eval_shell '(async () => { const GLib = (await import("gi://GLib")).default; const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const session = tray._contextMenuSession; const id = GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => GLib.SOURCE_REMOVE); session.refreshId = id; tray._sourceIds.add(id); const queued = session.refreshId > 0; await Main.extensionManager._callExtensionDisable("gnome-app-tray@radnotred.dev"); return queued; })()')
if [[ "$pending_refresh_result" != *"'true'"* ]]; then
  echo "Pending context refresh teardown failed: $pending_refresh_result" >&2
  exit 1
fi
eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); await Main.extensionManager._callExtensionEnable("gnome-app-tray@radnotred.dev"); return true; })()' >/dev/null
wait_for_tray_size 1
eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; tray._openContextMenu([...tray._entries.keys()][0], null); return true; })()' >/dev/null
sleep 0.1

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

placement_result=$(eval_shell '(async () => { const GLib = (await import("gi://GLib")).default; const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const entry = [...tray._entries.values()][0]; tray.settings.set_value("app-rules", new GLib.Variant("a{ss}", {[entry.info.key]: "panel"})); tray._reloadRules(); tray._syncIndicators(); const restored = entry.item.container.width === entry.original.containerWidth; return `${entry.info.key}:${restored ? "restored" : "collapsed"}`; })()')
if [[ "$placement_result" != *'sni:gnomeapptrayinteraction:restored'* ]]; then
  echo "Placement rule setup failed: $placement_result" >&2
  exit 1
fi
wait_for_tray_size 0

eval_shell '(async () => { const GLib = (await import("gi://GLib")).default; const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; tray.settings.set_value("app-rules", new GLib.Variant("a{ss}", {"sni:gnomeapptrayinteraction": "overflow"})); return true; })()' >/dev/null
wait_for_tray_size 1

# Exercise a quit-like menu action through the mirrored menu.
remove_action_result=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); const tray = Main.panel.statusArea["gnome-app-tray@radnotred.dev"]; const panelId = [...tray._entries.keys()][0]; tray._openContextMenu(panelId, null); const action = tray._contextItems.get_children().find(child => child.accessible_name?.includes("Remove mock indicator")); action?.emit("clicked", 1); return action ? "remove-clicked" : "remove-missing"; })()')
if [[ "$remove_action_result" != *'remove-clicked'* ]]; then
  echo "Quit-like menu action was not rendered: $remove_action_result" >&2
  exit 1
fi
wait "$mock_pid" 2>/dev/null || true
mock_pid=''
wait_for_tray_size 0

# Remove a separate app while its context menu is open.
start_mock 'gnome-app-tray-context-removal' 0
wait_for_tray_size 1
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
sleep 0.5

owner_disable_state=$(eval_shell '(async () => { const Main = await import("resource:///org/gnome/shell/ui/main.js"); await Main.extensionManager._callExtensionDisable("appindicatorsupport@rgcjonas.gmail.com"); return Main.extensionManager.lookup("appindicatorsupport@rgcjonas.gmail.com")?.state ?? -1; })()')
# GNOME session mode can refuse to disable a system extension. Only require its
# indicators to disappear when the manager actually changed its state.
if [[ "$owner_disable_state" != *"'1'"* ]]; then
  wait_for_tray_size 0
fi

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
