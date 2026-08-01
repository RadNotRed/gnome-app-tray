import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { AppTrayMenu } from './lib/appTrayMenu.js';

export default class AppTrayExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._tray = null;
    this._settings = null;
  }

  enable() {
    this._settings = this.getSettings();
    try {
      this._tray = new AppTrayMenu(this._settings, () => this.openPreferences());
      Main.panel.addToStatusArea(this.uuid, this._tray, 0, 'right');
    } catch (error) {
      logError(error, '[AppTray] Failed to enable');
      this._tray?.destroy();
      this._tray = null;
      this._settings = null;
      throw error;
    }
  }

  disable() {
    this._tray?.destroy();
    this._tray = null;
    this._settings = null;
  }
}
