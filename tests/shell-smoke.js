import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'gnome-app-tray@radnotred.dev';

export function init() {}

export async function run() {
  await Scripting.sleep(1000);

  const extension = Main.extensionManager.lookup(UUID);
  if (!extension || extension.state !== 1)
    throw new Error(`App Tray did not become active (state: ${extension?.state})`);

  const tray = Main.panel.statusArea[UUID];
  if (!tray) throw new Error('App Tray did not add its top-bar button');

  tray.menu.open();
  await Scripting.sleep(100);
  tray.menu.close();

  for (let iteration = 0; iteration < 10; iteration++) {
    await Main.extensionManager._callExtensionDisable(UUID);
    if (Main.panel.statusArea[UUID])
      throw new Error(`Tray survived disable cycle ${iteration + 1}`);

    await Main.extensionManager._callExtensionEnable(UUID);
    if (!Main.panel.statusArea[UUID])
      throw new Error(`Tray was not restored in enable cycle ${iteration + 1}`);
  }

  await Scripting.sleep(500);
}

export function finish() {}
