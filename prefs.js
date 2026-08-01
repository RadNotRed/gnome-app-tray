import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
  ExtensionPreferences,
  gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PLACEMENTS = [
  { value: 'overflow', label: 'Hidden icons flyout' },
  { value: 'panel', label: 'Top bar' },
];

function placementIndex(value) {
  const index = PLACEMENTS.findIndex((placement) => placement.value === value);
  return index >= 0 ? index : 0;
}

export default class AppTrayPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const settingsSignalIds = [];
    const connectSetting = (key, callback) => {
      settingsSignalIds.push(settings.connect(`changed::${key}`, callback));
    };

    window.set_default_size(620, 560);
    window.add(this._createAppearancePage(settings, connectSetting));
    window.add(this._createApplicationsPage(settings, connectSetting));

    window.connect('close-request', () => {
      for (const id of settingsSignalIds) settings.disconnect(id);
      settingsSignalIds.length = 0;
      return false;
    });
  }

  _createAppearancePage(settings, connectSetting) {
    const page = new Adw.PreferencesPage({
      title: _('Appearance'),
      icon_name: 'preferences-desktop-appearance-symbolic',
    });
    const group = new Adw.PreferencesGroup({
      title: _('Hidden Icons Flyout'),
      description: _('Configure the compact Windows-style tray menu.'),
    });
    page.add(group);

    const columnsAdjustment = new Gtk.Adjustment({
      value: settings.get_int('grid-columns'),
      lower: 2,
      upper: 8,
      step_increment: 1,
    });
    const columnsRow = new Adw.SpinRow({
      title: _('Columns'),
      subtitle: _('Maximum icons shown on each row'),
      adjustment: columnsAdjustment,
      value: settings.get_int('grid-columns'),
    });
    columnsAdjustment.connect('notify::value', () => {
      settings.set_int('grid-columns', Math.round(columnsAdjustment.value));
    });
    connectSetting('grid-columns', () => {
      columnsAdjustment.value = settings.get_int('grid-columns');
    });
    group.add(columnsRow);

    const iconSizeAdjustment = new Gtk.Adjustment({
      value: settings.get_int('popup-icon-size'),
      lower: 16,
      upper: 32,
      step_increment: 1,
    });
    const iconSizeRow = new Adw.SpinRow({
      title: _('Icon Size'),
      subtitle: _('Icons stay centered inside fixed 40 pixel cells'),
      adjustment: iconSizeAdjustment,
      value: settings.get_int('popup-icon-size'),
    });
    iconSizeAdjustment.connect('notify::value', () => {
      settings.set_int('popup-icon-size', Math.round(iconSizeAdjustment.value));
    });
    connectSetting('popup-icon-size', () => {
      iconSizeAdjustment.value = settings.get_int('popup-icon-size');
    });
    group.add(iconSizeRow);

    const helpGroup = new Adw.PreferencesGroup({
      title: _('Controls'),
    });
    helpGroup.add(
      new Adw.ActionRow({
        title: _('Mouse'),
        subtitle: _(
          'Left-click focuses an app, right-click opens its menu, and middle-click sends its secondary action.',
        ),
      }),
    );
    helpGroup.add(
      new Adw.ActionRow({
        title: _('Temporary order'),
        subtitle: _('Drag icons to rearrange them until the extension or GNOME Shell restarts.'),
      }),
    );
    page.add(helpGroup);

    return page;
  }

  _createApplicationsPage(settings, connectSetting) {
    const page = new Adw.PreferencesPage({
      title: _('Applications'),
      icon_name: 'view-grid-symbolic',
    });

    const behaviorGroup = new Adw.PreferencesGroup({
      title: _('Default Placement'),
      description: _('Choose where newly discovered tray applications appear.'),
    });
    const defaultPlacementRow = new Adw.ComboRow({
      title: _('New tray applications'),
      subtitle: _('You can override individual applications below'),
      model: Gtk.StringList.new(PLACEMENTS.map((placement) => _(placement.label))),
      selected: placementIndex(settings.get_string('default-placement')),
    });
    defaultPlacementRow.connect('notify::selected', () => {
      const placement = PLACEMENTS[defaultPlacementRow.selected] ?? PLACEMENTS[0];
      settings.set_string('default-placement', placement.value);
    });
    connectSetting('default-placement', () => {
      defaultPlacementRow.selected = placementIndex(settings.get_string('default-placement'));
    });
    behaviorGroup.add(defaultPlacementRow);
    page.add(behaviorGroup);

    const addGroup = new Adw.PreferencesGroup({
      title: _('Add Application Rule'),
      description: _(
        'Applications appear here after GNOME has seen their tray icon at least once.',
      ),
    });
    const addRow = new Adw.ComboRow({
      title: _('Application'),
      enable_search: true,
    });
    const addButton = new Gtk.Button({
      icon_name: 'list-add-symbolic',
      tooltip_text: _('Add placement rule'),
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
    });
    addRow.add_suffix(addButton);
    addGroup.add(addRow);
    page.add(addGroup);

    const rulesGroup = new Adw.PreferencesGroup({
      title: _('Application Rules'),
      description: _('Use − to return an application to the default placement.'),
    });
    page.add(rulesGroup);

    let availableIndicators = [];
    let ruleRows = [];

    const readKnownIndicators = () => {
      try {
        return settings
          .get_value('known-indicators')
          .deep_unpack()
          .map(([key, name, iconName]) => ({ key, name, iconName }));
      } catch (_error) {
        return [];
      }
    };

    const readRules = () => {
      try {
        return settings.get_value('app-rules').deep_unpack();
      } catch (_error) {
        return {};
      }
    };

    const writeRules = (rules) => {
      settings.set_value('app-rules', new GLib.Variant('a{ss}', rules));
    };

    const renderRules = () => {
      for (const row of ruleRows) rulesGroup.remove(row);
      ruleRows = [];

      const known = readKnownIndicators();
      const knownByKey = new Map(known.map((indicator) => [indicator.key, indicator]));
      const rules = readRules();

      availableIndicators = known
        .filter((indicator) => !(indicator.key in rules))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (availableIndicators.length > 0) {
        addRow.model = Gtk.StringList.new(availableIndicators.map((indicator) => indicator.name));
        addRow.selected = 0;
        addRow.sensitive = true;
        addButton.sensitive = true;
      } else {
        addRow.model = Gtk.StringList.new([_('No applications available')]);
        addRow.selected = 0;
        addRow.sensitive = false;
        addButton.sensitive = false;
      }

      const sortedRules = Object.entries(rules).sort(([aKey], [bKey]) => {
        const aName = knownByKey.get(aKey)?.name ?? aKey;
        const bName = knownByKey.get(bKey)?.name ?? bKey;
        return aName.localeCompare(bName);
      });

      if (sortedRules.length === 0) {
        const emptyRow = new Adw.ActionRow({
          title: _('No application-specific rules'),
          subtitle: _('All tray apps currently use the default placement'),
          sensitive: false,
        });
        rulesGroup.add(emptyRow);
        ruleRows.push(emptyRow);
        return;
      }

      for (const [key, placement] of sortedRules) {
        const knownIndicator = knownByKey.get(key);
        const row = new Adw.ActionRow({
          title: knownIndicator?.name ?? key,
          subtitle: key,
        });

        const appIcon = new Gtk.Image({
          icon_name: knownIndicator?.iconName || 'application-x-executable-symbolic',
          pixel_size: 20,
        });
        row.add_prefix(appIcon);

        const placementDropDown = new Gtk.DropDown({
          model: Gtk.StringList.new(PLACEMENTS.map((placementOption) => _(placementOption.label))),
          selected: placementIndex(placement),
          valign: Gtk.Align.CENTER,
          tooltip_text: _('Choose application placement'),
        });
        placementDropDown.connect('notify::selected', () => {
          const currentRules = readRules();
          if (!(key in currentRules)) return;
          currentRules[key] = PLACEMENTS[placementDropDown.selected]?.value ?? PLACEMENTS[0].value;
          writeRules(currentRules);
        });
        row.add_suffix(placementDropDown);

        const removeButton = new Gtk.Button({
          icon_name: 'list-remove-symbolic',
          tooltip_text: _('Remove application rule'),
          valign: Gtk.Align.CENTER,
          css_classes: ['flat'],
        });
        removeButton.connect('clicked', () => {
          const currentRules = readRules();
          delete currentRules[key];
          writeRules(currentRules);
        });
        row.add_suffix(removeButton);

        rulesGroup.add(row);
        ruleRows.push(row);
      }
    };

    addButton.connect('clicked', () => {
      const indicator = availableIndicators[addRow.selected];
      if (!indicator) return;

      const rules = readRules();
      rules[indicator.key] = 'overflow';
      writeRules(rules);
    });

    connectSetting('known-indicators', renderRules);
    connectSetting('app-rules', renderRules);
    renderRules();

    return page;
  }
}
