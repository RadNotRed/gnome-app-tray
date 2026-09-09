import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function settle() {
  return new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

export async function run(tray) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const row = (label) =>
    tray._contextItems.get_children().find((child) => child.accessible_name === label);
  const entry = [...tray._entries.values()][0];
  assert(!entry.item.menu.isOpen, 'Companion menu must remain closed');
  const root = tray._contextMenuSession.rootItem;
  const more = root.getChildren().find((child) => child.propertyGet('label') === 'More actions');
  assert(row('More actions') && !row('Recent item 12'), 'Submenus must start collapsed');
  assert(!tray._contextMenuSession.openedItems.has(more), 'Collapsed submenu was opened remotely');
  const popup = tray._contextPopup;
  assert(popup?.isOpen, 'Separate context popup did not open');
  assert(!tray.menu.actor.contains(popup.actor), 'Actions are still inside the tray');
  const traySize = [tray.menu.actor.width, tray.menu.actor.height];
  assert(traySize[0] < 280, 'Single-icon tray is unnecessarily wide');
  const width = popup.actor.width;
  const x = popup.actor.get_transformed_position()[0];
  const stable = row('Needs attention');
  const first = root.getChildren()[0];
  const originalLabel = first.propertyGet('label');
  const longLabel = 'A very long menu label '.repeat(25).trim();
  first.propertySet('label', GLib.Variant.new_string(longLabel));
  await settle();
  assert(popup.actor.width === width, `Long text changed width: ${width} to ${popup.actor.width}`);
  assert(Math.abs(popup.actor.get_transformed_position()[0] - x) < 1, 'Long text moved the popup');
  assert(row('Needs attention') === stable, 'Unchanged menu rows were recreated');
  const label = row(longLabel).child.get_children().at(-1);
  assert(label.clutter_text.get_layout().is_ellipsized(), 'Long action label was not ellipsized');
  for (let i = 0; i < 3; i++) {
    row('More actions').grab_key_focus();
    row('More actions').emit('clicked', 1);
    await settle();
    assert(row('Recent item 12'), 'Expanded submenu children are missing');
    assert(row('More actions').has_key_focus(), 'Expansion lost keyboard focus');
    assert(popup.actor.width === width, 'Expansion changed popup width');
    assert(
      tray.menu.actor.width === traySize[0] && tray.menu.actor.height === traySize[1],
      'Expanding app actions resized the tray',
    );
    const adjustment = tray._contextScrollView.get_vadjustment();
    adjustment.value = Math.min(60, adjustment.upper - adjustment.page_size);
    const scroll = adjustment.value;
    tray._renderContextMenu(entry);
    await settle();
    assert(Math.abs(adjustment.value - scroll) < 1, 'Menu refresh reset scrolling');
    row('More actions').emit('clicked', 1);
    await settle();
    assert(!row('Recent item 12'), 'Collapsing did not hide submenu children');
    assert(
      !tray._contextMenuSession.openedItems.has(more),
      'Collapsed submenu session stayed open',
    );
    assert(popup.actor.width === width, 'Collapse changed popup width');
  }
  first.propertySet('label', GLib.Variant.new_string(originalLabel));
  row('More actions').emit('clicked', 1);
  await settle();
  return 'dropdown-layout-ok';
}

export async function dismissal(tray) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const seat = Clutter.get_default_backend().get_default_seat();
  const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
  const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
  const pressEscape = async () => {
    keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_Escape,
      Clutter.KeyState.RELEASED,
    );
    await settle();
  };
  const entry = [...tray._entries.values()][0];
  const panelId = entry.info.panelId;
  const popup = tray._contextPopup;
  const size = [tray.menu.actor.width, tray.menu.actor.height];
  const baselineModals = Main.modalCount - 2;
  tray._openContextMenu(panelId, null);
  assert(tray._contextPopup === popup, 'Repeated context clicks stacked popups');
  await pressEscape();
  assert(!tray._contextPopup && tray.menu.isOpen, 'Escape should dismiss the app popup first');
  assert(tray._contextPopupManager._menus.length === 0, 'Closed popup was not released');
  await pressEscape();
  assert(
    !tray.menu.isOpen && Main.modalCount === baselineModals,
    'Second Escape left the tray or a grab open',
  );
  tray.menu.open();
  await settle();
  tray._openContextMenu(panelId, null);
  await settle();
  pointer.notify_absolute_motion(GLib.get_monotonic_time(), 10, 650);
  await settle();
  pointer.notify_button(
    GLib.get_monotonic_time(),
    Clutter.BUTTON_PRIMARY,
    Clutter.ButtonState.PRESSED,
  );
  pointer.notify_button(
    GLib.get_monotonic_time(),
    Clutter.BUTTON_PRIMARY,
    Clutter.ButtonState.RELEASED,
  );
  await settle();
  assert(!tray._contextPopup && !tray.menu.isOpen, 'Clicking outside did not dismiss both menus');
  assert(Main.modalCount === baselineModals, 'Outside dismissal leaked an input grab');
  tray.menu.open();
  await settle();
  tray._openContextMenu(panelId, null);
  await settle();
  assert(
    tray.menu.actor.width === size[0] && tray.menu.actor.height === size[1],
    'Reopening changed tray dimensions',
  );
  return 'popup-dismissal-ok';
}

export async function switching(tray) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const seat = Clutter.get_default_backend().get_default_seat();
  const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
  const click = async (actor, button) => {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + width / 2, y + height / 2);
    await settle();
    pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.PRESSED);
    pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED);
    await settle();
  };
  const entries = tray._orderedEntries();
  const baselineModals = Main.modalCount;
  const size = [tray.menu.actor.width, tray.menu.actor.height];
  for (const entry of [entries[0], entries[1], entries[0]]) {
    await click(entry.button, Clutter.BUTTON_SECONDARY);
    assert(
      tray._contextPopup?.isOpen && tray._activeContextPanelId === entry.info.panelId,
      `Right-click failed for ${entry.info.rawId}: active=${tray._activeContextPanelId}, tray=${tray.menu.isOpen}, popup=${tray._contextPopup?.isOpen}`,
    );
    assert(tray._contextPopupManager._menus.length === 1, 'Switching apps stacked popups');
    assert(Main.modalCount === baselineModals + 1, 'Switching apps leaked an input grab');
    assert(
      tray.menu.actor.width === size[0] && tray.menu.actor.height === size[1],
      'Switching apps resized the tray',
    );
  }
  await click(tray._titleLabel, Clutter.BUTTON_PRIMARY);
  assert(
    !tray._contextPopup && tray.menu.isOpen,
    'Clicking the tray header should dismiss only the app popup',
  );
  assert(Main.modalCount === baselineModals, 'Closing the app popup leaked a grab');
  return 'popup-switching-ok';
}
