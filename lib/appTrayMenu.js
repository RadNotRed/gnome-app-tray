import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CELL_SIZE = 40;
const DEFAULT_ICON_SIZE = 20;
const GRID_GAP = 4;
const MAX_COLUMNS = 8;
const MAX_VISIBLE_ROWS = 5;
const POLL_INTERVAL_MS = 500;
const OPENRGB_ICON_SCALE = 1.35;

// GObject types are process-global and survive extension disable/uninstall.
// Derive names from the full module URL so host-development copies can coexist
// with types cached by an earlier App Tray build in the same Shell process.
const MODULE_TYPE_SUFFIX = (() => {
  let hash = 2166136261;
  for (let index = 0; index < import.meta.url.length; index++) {
    hash ^= import.meta.url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
})();

// Keep foreign PanelMenu.Button actors alive, mapped, and owned by AppIndicator.
// Only collapse their panel allocation; never reparent or destroy them.
const COLLAPSED_PANEL_STYLE = [
  'width: 0px',
  'min-width: 0px',
  'padding: 0px',
  'margin: 0px',
  'border: 0px',
  '-natural-hpadding: 0px',
  '-minimum-hpadding: 0px',
].join('; ');

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

function safeString(value) {
  try {
    return value === null || value === undefined ? '' : String(value).trim();
  } catch (_error) {
    return '';
  }
}

function normalizeIdentity(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/\.desktop$/u, '')
    .replace(/[^a-z0-9]+/gu, '');
}

function isIndicator(panelId, item) {
  if (!item) return false;

  const constructorName = safeString(item.constructor?.name);
  return (
    panelId.startsWith('appindicator-') ||
    constructorName === 'IndicatorStatusIcon' ||
    constructorName === 'IndicatorStatusTrayIcon'
  );
}

function getIndicatorInfo(panelId, item) {
  try {
    const indicator = item._indicator ?? null;
    const sourceIcon = item.icon ?? item._icon ?? null;

    let rawId = safeString(indicator?.id);
    let title = safeString(indicator?.accessibleName) || safeString(indicator?.title);
    let iconName = safeString(sourceIcon?.icon_name);

    if (!rawId && sourceIcon) rawId = safeString(sourceIcon.wm_class);
    if (!rawId) rawId = safeString(item.uniqueId);
    if (!rawId) rawId = panelId.replace(/^appindicator-/u, '');

    if (!title) title = safeString(item.accessible_name);
    if (!title) title = rawId || 'Tray application';

    if (!iconName) iconName = safeString(indicator?.icon?.name);

    const normalized = normalizeIdentity(rawId) || normalizeIdentity(title);
    const prefix = indicator ? 'sni' : 'legacy';
    const key = `${prefix}:${normalized || normalizeIdentity(panelId)}`;

    return {
      panelId,
      item,
      indicator,
      sourceIcon,
      rawId,
      title,
      iconName,
      key,
      legacy: !indicator,
    };
  } catch (error) {
    logError(error, `[AppTray] Failed to inspect ${panelId}`);
    return null;
  }
}

const TrayIconButton = GObject.registerClass(
  { GTypeName: `GnomeAppTray_TrayIconButton_${MODULE_TYPE_SUFFIX}` },
  class TrayIconButton extends St.Button {
    constructor(info, iconSize, callbacks) {
      super({
        style_class: 'gnome-app-tray-cell',
        reactive: true,
        can_focus: true,
        track_hover: true,
        width: CELL_SIZE,
        height: CELL_SIZE,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: info.title,
      });

      this.panelId = info.panelId;
      this.trayOwner = callbacks.owner;
      this._callbacks = callbacks;
      this._iconSize = iconSize;
      this._sourceIcon = null;
      this._displayGicon = null;
      this._displayIconName = '';
      this._displayScale = 1;
      this._lastPrimaryEvent = null;

      this._iconBin = new St.Bin({
        style_class: 'gnome-app-tray-icon-bin',
        width: iconSize,
        height: iconSize,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        clip_to_allocation: true,
      });
      this.set_child(this._iconBin);
      this.sync(info, iconSize);

      this.connect('clicked', () => {
        this._callbacks.activate(this.panelId, this._lastPrimaryEvent);
        this._lastPrimaryEvent = null;
      });
      this.connect('button-press-event', (_actor, event) => this._onButtonPress(event));
      this.connect('scroll-event', (_actor, event) => {
        return this._callbacks.scroll(this.panelId, event);
      });
      this.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

      this._delegate = this;
      this._draggable = DND.makeDraggable(this, { restoreOnSuccess: true });
      this._draggable.connect('drag-begin', () => {
        this.add_style_pseudo_class('dragging');
      });
      this._draggable.connect('drag-end', () => {
        this.remove_style_pseudo_class('dragging');
        this._callbacks.dragEnd();
      });
    }

    _onButtonPress(event) {
      const button = event.get_button();
      const [x, y] = event.get_coords();
      const eventInfo = { x, y, time: event.get_time(), button };

      if (button === Clutter.BUTTON_SECONDARY) {
        this._callbacks.contextMenu(this.panelId, eventInfo);
        return Clutter.EVENT_STOP;
      }

      if (button === Clutter.BUTTON_MIDDLE) {
        this._callbacks.secondaryActivate(this.panelId, eventInfo);
        return Clutter.EVENT_STOP;
      }

      if (button === Clutter.BUTTON_PRIMARY) this._lastPrimaryEvent = eventInfo;
      return Clutter.EVENT_PROPAGATE;
    }

    _onKeyPress(event) {
      const symbol = event.get_key_symbol();
      const state = event.get_state();

      if (
        symbol === Clutter.KEY_Menu ||
        (symbol === Clutter.KEY_F10 && state & Clutter.ModifierType.SHIFT_MASK)
      ) {
        this._callbacks.contextMenu(this.panelId, null);
        return Clutter.EVENT_STOP;
      }

      if (state & Clutter.ModifierType.MOD1_MASK) {
        let direction = null;
        if (symbol === Clutter.KEY_Left) direction = 'left';
        else if (symbol === Clutter.KEY_Right) direction = 'right';
        else if (symbol === Clutter.KEY_Up) direction = 'up';
        else if (symbol === Clutter.KEY_Down) direction = 'down';

        if (direction) {
          this._callbacks.keyboardMove(this.panelId, direction);
          return Clutter.EVENT_STOP;
        }
      }

      return Clutter.EVENT_PROPAGATE;
    }

    sync(info, iconSize) {
      this.accessible_name = info.title;
      this._iconSize = iconSize;
      this._iconBin.set({ width: iconSize, height: iconSize });
      const scale = info.key === 'sni:openrgb' ? OPENRGB_ICON_SCALE : 1;
      this._setIcon(info.sourceIcon, info.iconName, scale);
    }

    _setIcon(sourceIcon, fallbackIconName, scale) {
      let gicon = null;
      let iconName = safeString(fallbackIconName);
      const renderSize = Math.round(this._iconSize * scale);

      try {
        gicon = sourceIcon?.gicon ?? null;
        if (!iconName) iconName = safeString(sourceIcon?.icon_name);
      } catch (_error) {
        gicon = null;
      }

      if (
        sourceIcon === this._sourceIcon &&
        gicon === this._displayGicon &&
        iconName === this._displayIconName &&
        scale === this._displayScale &&
        this._iconBin.child
      ) {
        if (this._iconBin.child instanceof St.Icon) this._iconBin.child.icon_size = renderSize;
        this._iconBin.child.set({ width: renderSize, height: renderSize });
        return;
      }

      const oldChild = this._iconBin.child;
      if (oldChild) this._iconBin.set_child(null);

      let iconActor;
      if (gicon) {
        iconActor = new St.Icon({
          gicon,
          icon_size: renderSize,
          style_class: 'gnome-app-tray-icon',
        });
      } else if (iconName) {
        iconActor = new St.Icon({
          icon_name: iconName,
          icon_size: renderSize,
          style_class: 'gnome-app-tray-icon',
        });
      } else if (sourceIcon instanceof Clutter.Actor) {
        iconActor = new Clutter.Clone({
          source: sourceIcon,
          width: renderSize,
          height: renderSize,
        });
      } else {
        iconActor = new St.Icon({
          icon_name: 'application-x-executable-symbolic',
          icon_size: renderSize,
          style_class: 'gnome-app-tray-icon',
        });
      }

      iconActor.set({
        width: renderSize,
        height: renderSize,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._iconBin.set_child(iconActor);

      if (oldChild) oldChild.destroy();
      this._sourceIcon = sourceIcon;
      this._displayGicon = gicon;
      this._displayIconName = iconName;
      this._displayScale = scale;
    }

    setDropTarget(active) {
      if (active) this.add_style_pseudo_class('drop-target');
      else this.remove_style_pseudo_class('drop-target');
    }

    getDragActor() {
      const iconProperties = this._displayGicon
        ? { gicon: this._displayGicon }
        : {
            icon_name: this._displayIconName || 'application-x-executable-symbolic',
          };

      return new St.Icon({
        ...iconProperties,
        icon_size: Math.round(this._iconSize * this._displayScale),
        width: CELL_SIZE,
        height: CELL_SIZE,
        style_class: 'gnome-app-tray-drag-icon',
      });
    }

    getDragActorSource() {
      return this._iconBin.child ?? this;
    }
  },
);

export const AppTrayMenu = GObject.registerClass(
  { GTypeName: `GnomeAppTray_AppTrayMenu_${MODULE_TYPE_SUFFIX}` },
  class AppTrayMenu extends PanelMenu.Button {
    constructor(settings, openPreferences) {
      super(0.5, 'Hidden icons', false);

      this.settings = settings;
      this._openPreferences = openPreferences;
      this._destroyed = false;
      this._entries = new Map();
      this._sessionOrder = [];
      this._settingsSignalIds = [];
      this._sourceIds = new Set();
      this._syncIdleId = 0;
      this._rebuildIdleId = 0;
      this._pollSourceId = 0;
      this._menuOpenStateId = 0;
      this._activeContextPanelId = null;
      this._dropTargetPanelId = null;
      this._lastDropIndex = -1;
      this._rules = {};
      this._defaultPlacement = 'overflow';

      this._panelIcon = new St.Icon({
        icon_name: 'pan-down-symbolic',
        style_class: 'system-status-icon gnome-app-tray-panel-icon',
      });
      this.add_child(this._panelIcon);

      this._buildMenu();
      this._reloadRules();
      this._connectSettings();

      this._menuOpenStateId = this.menu.connect('open-state-changed', (_menu, open) => {
        if (open) {
          this._syncIndicators();
          this._rebuildGrid();
        } else this._clearContextMenu();
      });

      this._pollSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        this._syncIndicators();
        return GLib.SOURCE_CONTINUE;
      });

      this._queueSync();
    }

    _buildMenu() {
      this._content = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'gnome-app-tray-content',
        x_expand: true,
      });

      const header = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style_class: 'gnome-app-tray-header',
        x_expand: true,
      });
      this._titleLabel = new St.Label({
        text: 'Hidden icons',
        style_class: 'gnome-app-tray-title',
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      this._settingsButton = new St.Button({
        style_class: 'gnome-app-tray-settings-button',
        can_focus: true,
        reactive: true,
        accessible_name: 'Open App Tray settings',
        child: new St.Icon({
          icon_name: 'emblem-system-symbolic',
          icon_size: 16,
        }),
      });
      this._settingsButton.connect('clicked', () => {
        this.menu.close();
        this._scheduleAction(() => this._openPreferences?.());
      });
      header.add_child(this._titleLabel);
      header.add_child(this._settingsButton);
      this._content.add_child(header);

      this._gridLayout = new Clutter.GridLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        column_homogeneous: true,
        row_homogeneous: true,
        column_spacing: GRID_GAP,
        row_spacing: GRID_GAP,
      });
      this._grid = new St.Widget({
        layout_manager: this._gridLayout,
        style_class: 'gnome-app-tray-grid',
        x_align: Clutter.ActorAlign.START,
      });
      this._grid._delegate = this;

      this._scrollContent = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
      });
      this._scrollContent.add_child(this._grid);

      this._scrollView = new St.ScrollView({
        style_class: 'gnome-app-tray-scroll-view',
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
        x_expand: true,
        child: this._scrollContent,
      });
      this._content.add_child(this._scrollView);

      this._emptyState = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'gnome-app-tray-empty',
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._emptyState.add_child(
        new St.Icon({
          icon_name: 'view-grid-symbolic',
          icon_size: 24,
          style_class: 'gnome-app-tray-empty-icon',
          x_align: Clutter.ActorAlign.CENTER,
        }),
      );
      this._emptyState.add_child(
        new St.Label({
          text: 'No hidden icons yet',
          style_class: 'gnome-app-tray-empty-title',
          x_align: Clutter.ActorAlign.CENTER,
        }),
      );
      this._emptyState.add_child(
        new St.Label({
          text: 'New tray apps appear here automatically',
          style_class: 'gnome-app-tray-empty-subtitle',
          x_align: Clutter.ActorAlign.CENTER,
        }),
      );
      this._content.add_child(this._emptyState);

      this._contextPanel = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'gnome-app-tray-context-panel',
        x_expand: true,
        visible: false,
      });
      const contextHeader = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style_class: 'gnome-app-tray-context-header',
        x_expand: true,
      });
      this._contextTitle = new St.Label({
        style_class: 'gnome-app-tray-context-title',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const contextClose = new St.Button({
        style_class: 'gnome-app-tray-context-close',
        accessible_name: 'Close application menu',
        can_focus: true,
        reactive: true,
        child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14 }),
      });
      contextClose.connect('clicked', () => this._clearContextMenu());
      contextHeader.add_child(this._contextTitle);
      contextHeader.add_child(contextClose);
      this._contextPanel.add_child(contextHeader);

      this._contextItems = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'gnome-app-tray-context-items',
        x_expand: true,
      });
      this._contextPanel.add_child(this._contextItems);
      this._content.add_child(this._contextPanel);

      this._popupItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: 'gnome-app-tray-popup-item',
      });
      this._popupItem.add_child(this._content);
      this.menu.addMenuItem(this._popupItem);
    }

    _connectSettings() {
      const connect = (key, callback) => {
        this._settingsSignalIds.push(this.settings.connect(`changed::${key}`, callback));
      };

      connect('grid-columns', () => this._queueRebuild());
      connect('popup-icon-size', () => this._queueRebuild());
      connect('default-placement', () => {
        this._reloadRules();
        this._queueSync();
      });
      connect('app-rules', () => {
        this._reloadRules();
        this._queueSync();
      });
    }

    _reloadRules() {
      try {
        this._rules = this.settings.get_value('app-rules').deep_unpack();
      } catch (error) {
        logError(error, '[AppTray] Failed to load application rules');
        this._rules = {};
      }

      const placement = this.settings.get_string('default-placement');
      this._defaultPlacement = placement === 'panel' ? 'panel' : 'overflow';
    }

    _placementFor(key) {
      const placement = this._rules[key];
      return placement === 'panel' || placement === 'overflow' ? placement : this._defaultPlacement;
    }

    _queueSync() {
      if (this._destroyed || this._syncIdleId) return;

      this._syncIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._syncIdleId = 0;
        if (!this._destroyed) this._syncIndicators();
        return GLib.SOURCE_REMOVE;
      });
    }

    _queueRebuild() {
      if (this._destroyed || this._rebuildIdleId) return;

      this._rebuildIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._rebuildIdleId = 0;
        if (!this._destroyed) this._rebuildGrid();
        return GLib.SOURCE_REMOVE;
      });
    }

    _syncIndicators() {
      if (this._destroyed) return;

      const candidates = new Map();
      for (const [panelId, item] of Object.entries(Main.panel.statusArea)) {
        if (panelId === 'gnome-app-tray@radnotred.dev' || !isIndicator(panelId, item)) continue;

        const info = getIndicatorInfo(panelId, item);
        if (!info) continue;

        this._rememberIndicator(info);
        if (this._placementFor(info.key) === 'overflow') candidates.set(panelId, info);
      }

      let changed = false;
      for (const [panelId, entry] of [...this._entries]) {
        const info = candidates.get(panelId);
        if (!info || info.item !== entry.item || entry.dead) {
          this._removeEntry(panelId);
          changed = true;
        }
      }

      for (const [panelId, info] of candidates) {
        let entry = this._entries.get(panelId);
        if (!entry) {
          entry = this._addEntry(info);
          changed = Boolean(entry) || changed;
        } else {
          if (entry.sourceIcon !== info.sourceIcon) {
            this._disconnectSourceSignals(entry);
            entry.sourceIcon = info.sourceIcon;
            this._connectSourceIcon(entry);
          }
          entry.info = info;
          entry.button.sync(info, this._getIconSize());
          this._collapseOriginal(entry);
        }
      }

      if (changed) this._queueRebuild();
    }

    _rememberIndicator(info) {
      let known;
      try {
        known = this.settings.get_value('known-indicators').deep_unpack();
      } catch (_error) {
        known = [];
      }

      const existing = known.find(([key]) => key === info.key);
      if (existing) return;

      known.push([info.key, info.title, info.iconName]);
      known.sort((a, b) => a[1].localeCompare(b[1]));

      try {
        this.settings.set_value('known-indicators', new GLib.Variant('a(sss)', known));
      } catch (error) {
        logError(error, `[AppTray] Failed to remember ${info.title}`);
      }
    }

    _addEntry(info) {
      const callbacks = {
        owner: this,
        activate: (panelId, eventInfo) => this._activate(panelId, eventInfo),
        contextMenu: (panelId, eventInfo) => this._openContextMenu(panelId, eventInfo),
        secondaryActivate: (panelId, eventInfo) => this._secondaryActivate(panelId, eventInfo),
        scroll: (panelId, event) => this._scroll(panelId, event),
        dragEnd: () => this._onDragEnd(),
        keyboardMove: (panelId, direction) => this._keyboardMove(panelId, direction),
      };

      const button = new TrayIconButton(info, this._getIconSize(), callbacks);
      const item = info.item;
      const entry = {
        info,
        item,
        button,
        dead: false,
        applyingCollapsedState: false,
        signals: [],
        sourceSignals: [],
        sourceIcon: info.sourceIcon,
        original: {
          style: item.style,
          opacity: item.opacity,
          reactive: item.reactive,
          canFocus: item.can_focus,
          trackHover: item.track_hover,
        },
      };

      // Commit ownership of our proxy before touching the foreign actor. If a
      // setter throws, cleanup can still restore the entry transactionally.
      this._entries.set(info.panelId, entry);
      if (!this._sessionOrder.includes(info.panelId)) this._sessionOrder.push(info.panelId);

      try {
        entry.signals.push(
          item.connect('destroy', () => {
            // Never destroy a parent/proxy synchronously from a foreign child's
            // destroy signal. Reconcile after AppIndicator unwinds instead.
            entry.dead = true;
            this._queueSync();
          }),
        );
        entry.signals.push(item.connect('notify::visible', () => this._queueRebuild()));
        entry.signals.push(
          item.connect('style-changed', () => this._onOriginalStyleChanged(entry)),
        );
        entry.signals.push(
          item.connect('notify::opacity', () => this._onOriginalOpacityChanged(entry)),
        );
        this._connectSourceIcon(entry);
        this._collapseOriginal(entry);
        return entry;
      } catch (error) {
        logError(error, `[AppTray] Failed to proxy ${info.title}`);
        this._removeEntry(info.panelId);
        return null;
      }
    }

    _connectSourceIcon(entry) {
      const sourceIcon = entry.info.sourceIcon;
      if (!(sourceIcon instanceof Clutter.Actor)) return;

      for (const signal of ['notify::gicon', 'notify::icon-name', 'notify::content']) {
        try {
          entry.sourceSignals.push(
            sourceIcon.connect(signal, () => {
              if (!entry.dead && !this._destroyed)
                entry.button.sync(entry.info, this._getIconSize());
            }),
          );
        } catch (_error) {
          // Not every icon actor exposes every property.
        }
      }
    }

    _disconnectSourceSignals(entry) {
      for (const id of entry.sourceSignals) {
        try {
          entry.sourceIcon?.disconnect(id);
        } catch (_error) {
          // The source icon may already be disposed.
        }
      }
      entry.sourceSignals.length = 0;
    }

    _onOriginalStyleChanged(entry) {
      if (entry.dead || entry.applyingCollapsedState || this._destroyed) return;

      try {
        if (entry.item.style !== COLLAPSED_PANEL_STYLE) {
          entry.original.style = entry.item.style;
          this._collapseOriginal(entry);
        }
      } catch (_error) {
        entry.dead = true;
        this._queueSync();
      }
    }

    _onOriginalOpacityChanged(entry) {
      if (entry.dead || entry.applyingCollapsedState || this._destroyed) return;

      try {
        if (entry.item.opacity !== 0) {
          entry.original.opacity = entry.item.opacity;
          this._collapseOriginal(entry);
        }
      } catch (_error) {
        entry.dead = true;
        this._queueSync();
      }
    }

    _collapseOriginal(entry) {
      if (entry.dead || entry.applyingCollapsedState) return;

      entry.applyingCollapsedState = true;
      try {
        entry.item.style = COLLAPSED_PANEL_STYLE;
        entry.item.opacity = 0;
        entry.item.reactive = false;
        entry.item.can_focus = false;
        entry.item.track_hover = false;
      } catch (error) {
        logError(error, `[AppTray] Failed to collapse ${entry.info.title}`);
      } finally {
        entry.applyingCollapsedState = false;
      }
    }

    _disconnectEntrySignals(entry) {
      if (entry.dead) {
        entry.sourceSignals.length = 0;
        entry.signals.length = 0;
        return;
      }

      this._disconnectSourceSignals(entry);

      for (const id of entry.signals) {
        try {
          entry.item.disconnect(id);
        } catch (_error) {
          // The foreign item may already be disposed.
        }
      }
      entry.signals.length = 0;
    }

    _restoreOriginal(entry) {
      if (entry.dead) return;

      try {
        entry.item.style = entry.original.style ?? null;
        entry.item.opacity = entry.original.opacity;
        entry.item.reactive = entry.original.reactive;
        entry.item.can_focus = entry.original.canFocus;
        entry.item.track_hover = entry.original.trackHover;
      } catch (error) {
        logError(error, `[AppTray] Failed to restore ${entry.info.title}`);
      }
    }

    _removeEntry(panelId) {
      const entry = this._entries.get(panelId);
      if (!entry) return;

      this._entries.delete(panelId);
      this._disconnectEntrySignals(entry);

      if (this._activeContextPanelId === panelId) this._clearContextMenu();

      this._restoreOriginal(entry);

      try {
        if (entry.button.get_parent()) entry.button.get_parent().remove_child(entry.button);
        entry.button.destroy();
      } catch (error) {
        logError(error, `[AppTray] Failed to remove proxy for ${entry.info.title}`);
      }
    }

    _getColumns(count = this._entries.size) {
      const columns = clamp(this.settings.get_int('grid-columns') || 4, 2, MAX_COLUMNS);
      return Math.max(1, Math.min(columns, Math.max(1, count)));
    }

    _getIconSize() {
      return clamp(this.settings.get_int('popup-icon-size') || DEFAULT_ICON_SIZE, 16, 32);
    }

    _orderedEntries() {
      const order = new Map(this._sessionOrder.map((id, index) => [id, index]));
      return [...this._entries.values()]
        .filter((entry) => {
          try {
            return !entry.dead && entry.item.visible;
          } catch (_error) {
            return false;
          }
        })
        .sort((a, b) => {
          const aOrder = order.get(a.info.panelId) ?? Number.MAX_SAFE_INTEGER;
          const bOrder = order.get(b.info.panelId) ?? Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return a.info.title.localeCompare(b.info.title);
        });
    }

    _rebuildGrid() {
      if (this._destroyed) return;

      const entries = this._orderedEntries();
      const columns = this._getColumns(entries.length);
      const iconSize = this._getIconSize();

      for (const child of this._grid.get_children()) this._grid.remove_child(child);

      entries.forEach((entry, index) => {
        entry.button.sync(entry.info, iconSize);
        this._gridLayout.attach(entry.button, index % columns, Math.floor(index / columns), 1, 1);
      });

      const visibleRows = Math.min(
        MAX_VISIBLE_ROWS,
        Math.max(1, Math.ceil(entries.length / columns)),
      );
      const maxHeight = visibleRows * CELL_SIZE + Math.max(0, visibleRows - 1) * GRID_GAP;
      this._scrollView.style = `max-height: ${maxHeight}px;`;

      this._scrollView.visible = entries.length > 0;
      this._emptyState.visible = entries.length === 0;
      this._titleLabel.text =
        entries.length === 1 ? '1 hidden icon' : `${entries.length} hidden icons`;
      this.accessible_name =
        entries.length === 1
          ? 'Hidden icons, 1 application'
          : `Hidden icons, ${entries.length} applications`;
    }

    _scheduleAction(callback) {
      if (this._destroyed) return 0;

      const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._sourceIds.delete(id);
        if (!this._destroyed) {
          try {
            const result = callback();
            if (result?.catch) result.catch((error) => logError(error, '[AppTray] Action failed'));
          } catch (error) {
            logError(error, '[AppTray] Action failed');
          }
        }
        return GLib.SOURCE_REMOVE;
      });
      this._sourceIds.add(id);
      return id;
    }

    _activate(panelId, eventInfo) {
      const entry = this._entries.get(panelId);
      if (!entry || entry.dead) return;

      this.menu.close();
      this._scheduleAction(() => {
        if (entry.dead || !this._entries.has(panelId)) return;

        const time = eventInfo?.time ?? global.get_current_time();
        if (this._focusMatchingWindow(entry.info, time)) return;

        const indicator = entry.info.indicator;
        if (indicator?.supportsActivation === false && entry.item.menu?.numMenuItems) {
          this._openContextMenu(panelId, eventInfo);
          return;
        }

        if (typeof indicator?.open === 'function') {
          const [fallbackX, fallbackY] = this.get_transformed_position();
          return indicator.open(eventInfo?.x ?? fallbackX, eventInfo?.y ?? fallbackY, time);
        }

        this._clickLegacyIndicator(entry, Clutter.BUTTON_PRIMARY, eventInfo);
      });
    }

    _focusMatchingWindow(info, timestamp) {
      const candidates = [info.rawId, info.title, info.indicator?._commandLine]
        .map(normalizeIdentity)
        .filter((value) => value.length >= 4);
      if (candidates.length === 0) return false;

      let bestWindow = null;
      let bestScore = 0;

      for (const actor of global.get_window_actors()) {
        const window = actor.meta_window;
        const windowValues = [
          window.get_wm_class?.(),
          window.get_wm_class_instance?.(),
          window.get_gtk_application_id?.(),
          window.get_title?.(),
        ]
          .map(normalizeIdentity)
          .filter(Boolean);

        for (const candidate of candidates) {
          for (const value of windowValues) {
            let score = 0;
            if (candidate === value) score = 100;
            else if (candidate.includes(value) || value.includes(candidate)) score = 50;

            if (score > bestScore) {
              bestScore = score;
              bestWindow = window;
            }
          }
        }
      }

      if (!bestWindow || bestScore < 50) return false;

      try {
        if (bestWindow.minimized) bestWindow.unminimize();
        bestWindow.activate(timestamp);
        return true;
      } catch (error) {
        logError(error, `[AppTray] Failed to focus ${info.title}`);
        return false;
      }
    }

    _openContextMenu(panelId, eventInfo) {
      const entry = this._entries.get(panelId);
      if (!entry || entry.dead) return;

      const menu = entry.item.menu;
      if (!menu || !menu.numMenuItems) {
        this.menu.close();
        this._scheduleAction(() =>
          this._clickLegacyIndicator(entry, Clutter.BUTTON_SECONDARY, eventInfo),
        );
        return;
      }

      // GNOME's panel menu manager permits one top-level menu at a time. Opening
      // the AppIndicator-owned menu here would necessarily close our flyout, so
      // mirror its actions into an owned inline panel instead. Foreign actors
      // and their menu ownership remain untouched.
      if (!this.menu.isOpen) this.menu.open();
      if (this._activeContextPanelId === panelId && this._contextPanel.visible) return;

      this._activeContextPanelId = panelId;
      this._renderContextMenu(entry);
    }

    _clearContextMenu() {
      this._activeContextPanelId = null;
      if (!this._contextItems || !this._contextPanel) return;

      for (const child of this._contextItems.get_children()) child.destroy();
      this._contextPanel.hide();
    }

    _menuItemProperty(item, name, fallback = '') {
      try {
        return item._dbusItem?.propertyGet(name) ?? fallback;
      } catch (_error) {
        return fallback;
      }
    }

    _menuItemInt(item, name, fallback = 0) {
      try {
        return item._dbusItem?.propertyGetInt(name) ?? fallback;
      } catch (_error) {
        return fallback;
      }
    }

    _menuItems(menu) {
      try {
        return menu?._getMenuItems?.() ?? [];
      } catch (_error) {
        return [];
      }
    }

    _renderContextMenu(entry) {
      if (entry.dead || this._activeContextPanelId !== entry.info.panelId) return;

      for (const child of this._contextItems.get_children()) child.destroy();
      this._contextTitle.text = entry.info.title;

      const visited = new Set();
      const addMenu = (menu, depth = 0) => {
        if (!menu || visited.has(menu) || depth > 4) return;
        visited.add(menu);

        for (const sourceItem of this._menuItems(menu)) {
          try {
            if (!sourceItem.visible) continue;
          } catch (_error) {
            continue;
          }

          const constructorName = safeString(sourceItem.constructor?.name);
          const label =
            safeString(sourceItem.label?.text) ||
            safeString(this._menuItemProperty(sourceItem, 'label'));
          const submenu = sourceItem.menu;
          const submenuItems = this._menuItems(submenu);

          if (constructorName.includes('Separator')) {
            this._contextItems.add_child(
              new St.Widget({ style_class: 'gnome-app-tray-context-separator' }),
            );
            continue;
          }

          if (submenuItems.length > 0) {
            if (label) this._contextItems.add_child(this._createContextHeading(label, depth));
            addMenu(submenu, depth + 1);
            continue;
          }

          if (!label) continue;
          this._contextItems.add_child(this._createContextAction(entry, sourceItem, label, depth));
        }
      };

      addMenu(entry.item.menu);
      if (this._contextItems.get_children().length === 0) {
        this._contextItems.add_child(
          new St.Label({
            text: 'No actions available',
            style_class: 'gnome-app-tray-context-empty',
          }),
        );
      }
      this._contextPanel.show();
    }

    _createContextHeading(label, depth) {
      const row = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style_class: 'gnome-app-tray-context-heading',
        x_expand: true,
      });
      row.set_style(`padding-left: ${8 + depth * 14}px;`);
      row.add_child(
        new St.Label({
          text: label,
          x_expand: true,
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );
      row.add_child(new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 12 }));
      return row;
    }

    _createContextAction(entry, sourceItem, label, depth) {
      const content = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_expand: true,
      });
      content.set_style(`padding-left: ${depth * 14}px;`);

      const toggleType = safeString(this._menuItemProperty(sourceItem, 'toggle-type'));
      const toggleState = this._menuItemInt(sourceItem, 'toggle-state');
      let leadingIcon = null;
      if (toggleType === 'checkmark' && toggleState)
        leadingIcon = new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 14 });
      else if (toggleType === 'radio' && toggleState)
        leadingIcon = new St.Icon({ icon_name: 'media-record-symbolic', icon_size: 10 });
      else {
        const sourceIcon = sourceItem._icon;
        const gicon = sourceIcon?.gicon ?? null;
        const iconName = safeString(sourceIcon?.icon_name);
        if (gicon || iconName) {
          leadingIcon = new St.Icon({
            ...(gicon ? { gicon } : { icon_name: iconName }),
            icon_size: 16,
          });
        }
      }

      const iconSlot = new St.Bin({
        style_class: 'gnome-app-tray-context-icon-slot',
        child: leadingIcon,
      });
      content.add_child(iconSlot);
      content.add_child(
        new St.Label({
          text: label.replace(/_([^_])/u, '$1'),
          x_expand: true,
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );

      const action = new St.Button({
        style_class: 'gnome-app-tray-context-action',
        accessible_name: label,
        can_focus: true,
        reactive: sourceItem.reactive !== false,
        x_expand: true,
        child: content,
      });
      action.connect('clicked', () => this._activateContextAction(entry, sourceItem, action));
      return action;
    }

    _activateContextAction(entry, sourceItem, action) {
      if (entry.dead || this._activeContextPanelId !== entry.info.panelId) return;

      try {
        const timestamp = global.get_current_time();
        const dbusItem = sourceItem._dbusItem;
        if (typeof dbusItem?.handleEvent === 'function') {
          sourceItem._dbusClient?.indicator?.provideActivationToken?.(timestamp);
          const result = dbusItem.handleEvent('clicked', GLib.Variant.new('i', 0), timestamp);
          result?.catch?.((error) =>
            logError(error, `[AppTray] Menu action failed for ${entry.info.title}`),
          );
        } else {
          const event = Clutter.get_current_event();
          if (!event) throw new Error('No input event is available for this menu action');
          sourceItem.activate(event);
        }
      } catch (error) {
        logError(error, `[AppTray] Failed to activate menu item for ${entry.info.title}`);
      }

      this._scheduleAction(() => {
        if (!entry.dead && this._activeContextPanelId === entry.info.panelId)
          this._renderContextMenu(entry);
      });
    }

    _secondaryActivate(panelId, eventInfo) {
      const entry = this._entries.get(panelId);
      if (!entry || entry.dead) return;

      this.menu.close();
      this._scheduleAction(() => {
        const indicator = entry.info.indicator;
        if (typeof indicator?.secondaryActivate === 'function') {
          const [fallbackX, fallbackY] = this.get_transformed_position();
          return indicator.secondaryActivate(
            eventInfo?.time ?? global.get_current_time(),
            eventInfo?.x ?? fallbackX,
            eventInfo?.y ?? fallbackY,
          );
        }

        this._clickLegacyIndicator(entry, Clutter.BUTTON_MIDDLE, eventInfo);
      });
    }

    _clickLegacyIndicator(entry, button, eventInfo) {
      const icon = entry.item._icon ?? entry.item.icon;
      if (typeof icon?.click !== 'function') return;

      try {
        const event = Clutter.Event.new(Clutter.EventType.BUTTON_RELEASE);
        event.set_button(button);
        event.set_time(eventInfo?.time ?? global.get_current_time());
        event.set_stage(global.stage);
        event.set_source(entry.button);
        const [fallbackX, fallbackY] = this.get_transformed_position();
        event.set_coords(eventInfo?.x ?? fallbackX, eventInfo?.y ?? fallbackY);
        icon.click(event);
      } catch (error) {
        logError(error, `[AppTray] Failed legacy click for ${entry.info.title}`);
      }
    }

    _scroll(panelId, event) {
      const entry = this._entries.get(panelId);
      const indicator = entry?.info.indicator;
      if (!entry || entry.dead || typeof indicator?.scroll !== 'function')
        return Clutter.EVENT_PROPAGATE;

      if (event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH) {
        const [dx, dy] = event.get_scroll_delta();
        indicator.scroll(dx, dy);
        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    }

    _onDragEnd() {
      this._clearDropTarget();
    }

    _clearDropTarget() {
      if (this._dropTargetPanelId)
        this._entries.get(this._dropTargetPanelId)?.button.setDropTarget(false);
      this._dropTargetPanelId = null;
      this._lastDropIndex = -1;
    }

    handleDragOver(source, _actor, x, y, _time) {
      if (!(source instanceof TrayIconButton) || source.trayOwner !== this)
        return DND.DragMotionResult.NO_DROP;

      const entries = this._orderedEntries();
      if (entries.length < 2) return DND.DragMotionResult.NO_DROP;

      const columns = this._getColumns(entries.length);
      const col = clamp(Math.floor(x / (CELL_SIZE + GRID_GAP)), 0, columns - 1);
      const row = Math.max(0, Math.floor(y / (CELL_SIZE + GRID_GAP)));
      const index = clamp(row * columns + col, 0, entries.length - 1);

      if (index !== this._lastDropIndex) {
        this._clearDropTarget();
        this._lastDropIndex = index;
        const target = entries[index];
        if (target.info.panelId !== source.panelId) {
          this._dropTargetPanelId = target.info.panelId;
          target.button.setDropTarget(true);
        }
      }

      return this._dropTargetPanelId
        ? DND.DragMotionResult.MOVE_DROP
        : DND.DragMotionResult.NO_DROP;
    }

    acceptDrop(source, _actor, _x, _y, _time) {
      if (
        !(source instanceof TrayIconButton) ||
        source.trayOwner !== this ||
        !this._dropTargetPanelId
      ) {
        this._clearDropTarget();
        return false;
      }

      this._movePanelId(source.panelId, this._dropTargetPanelId);
      this._clearDropTarget();
      this._rebuildGrid();
      return true;
    }

    _movePanelId(sourceId, targetId) {
      const visibleIds = this._orderedEntries().map((entry) => entry.info.panelId);
      const sourceIndex = visibleIds.indexOf(sourceId);
      const targetIndex = visibleIds.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;

      visibleIds.splice(sourceIndex, 1);
      visibleIds.splice(targetIndex, 0, sourceId);

      const visibleSet = new Set(visibleIds);
      this._sessionOrder = [
        ...visibleIds,
        ...this._sessionOrder.filter((id) => !visibleSet.has(id)),
      ];
    }

    _keyboardMove(panelId, direction) {
      const entries = this._orderedEntries();
      const ids = entries.map((entry) => entry.info.panelId);
      const index = ids.indexOf(panelId);
      if (index < 0) return;

      const columns = this._getColumns(entries.length);
      let targetIndex = index;
      if (direction === 'left') targetIndex--;
      else if (direction === 'right') targetIndex++;
      else if (direction === 'up') targetIndex -= columns;
      else if (direction === 'down') targetIndex += columns;

      targetIndex = clamp(targetIndex, 0, ids.length - 1);
      if (targetIndex === index) return;

      this._movePanelId(panelId, ids[targetIndex]);
      this._rebuildGrid();
      this._entries.get(panelId)?.button.grab_key_focus();
    }

    _dispose() {
      if (this._destroyed) return;
      this._destroyed = true;

      if (this._menuOpenStateId) {
        try {
          this.menu.disconnect(this._menuOpenStateId);
        } catch (_error) {
          // The menu may already be disposing.
        }
        this._menuOpenStateId = 0;
      }

      for (const id of this._settingsSignalIds) {
        try {
          this.settings.disconnect(id);
        } catch (_error) {
          // Settings may already be disposing.
        }
      }
      this._settingsSignalIds.length = 0;

      for (const id of [this._pollSourceId, this._syncIdleId, this._rebuildIdleId]) {
        if (id) GLib.Source.remove(id);
      }
      this._pollSourceId = 0;
      this._syncIdleId = 0;
      this._rebuildIdleId = 0;

      for (const id of this._sourceIds) GLib.Source.remove(id);
      this._sourceIds.clear();

      this._clearContextMenu();

      for (const panelId of [...this._entries.keys()]) this._removeEntry(panelId);
      this._entries.clear();
    }

    _onDestroy() {
      this._dispose();
      super._onDestroy();
    }

    destroy() {
      this._dispose();
      super.destroy();
    }
  },
);
