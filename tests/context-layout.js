import GLib from 'gi://GLib';

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
  const width = tray.menu.actor.width;
  const x = tray.menu.actor.get_transformed_position()[0];
  const stable = row('Needs attention');
  const originalTitle = entry.info.title;
  const first = root.getChildren()[0];
  const originalLabel = first.propertyGet('label');
  const longLabel = 'A very long menu label '.repeat(25).trim();
  entry.info.title = longLabel;
  first.propertySet('label', GLib.Variant.new_string(longLabel));
  await settle();
  assert(
    tray.menu.actor.width === width,
    `Long text changed width: ${width} to ${tray.menu.actor.width}`,
  );
  assert(
    Math.abs(tray.menu.actor.get_transformed_position()[0] - x) < 1,
    'Long text moved the popup',
  );
  assert(row('Needs attention') === stable, 'Unchanged menu rows were recreated');
  const label = row(longLabel).child.get_children().at(-1);
  assert(label.clutter_text.get_layout().is_ellipsized(), 'Long action label was not ellipsized');
  assert(
    tray._contextTitle.clutter_text.get_layout().is_ellipsized(),
    'Long title was not ellipsized',
  );
  for (let i = 0; i < 3; i++) {
    row('More actions').grab_key_focus();
    row('More actions').emit('clicked', 1);
    await settle();
    assert(row('Recent item 12'), 'Expanded submenu children are missing');
    assert(row('More actions').has_key_focus(), 'Expansion lost keyboard focus');
    assert(tray.menu.actor.width === width, 'Expansion changed popup width');
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
    assert(tray.menu.actor.width === width, 'Collapse changed popup width');
  }
  entry.info.title = originalTitle;
  first.propertySet('label', GLib.Variant.new_string(originalLabel));
  row('More actions').emit('clicked', 1);
  await settle();
  return 'dropdown-layout-ok';
}
