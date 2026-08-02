# GNOME App Tray

A Windows-style hidden-icons flyout for the GNOME 50 top bar. It works with the AppIndicator/KStatusNotifierItem extension and keeps application indicators responsive without taking ownership of their actors or menus.

## What it does

- Finds indicators that start before or after App Tray and removes them cleanly when an app exits.
- Shows owned proxy buttons in an aligned, scrollable 40 × 40 pixel grid with configurable 16–32 pixel icons.
- Left-clicks focus an existing app window, falling back to the app indicator's normal activation action.
- Right-clicks open the application's original menu; middle-click and scroll actions are forwarded when supported.
- Lets icons be dragged into a temporary order. `Alt` + arrow keys provide the keyboard equivalent.
- Stores a default placement and per-application top-bar/hidden-flyout rules on a separate Applications settings page with + and − controls.
- Restores every original indicator state when an app exits, its owner extension stops, or App Tray is disabled.

App Tray organizes applications that already expose a tray indicator. GNOME Shell cannot keep an arbitrary application alive after it exits or safely turn every close button into “minimize to tray”; that behavior still has to be supported by the application.

## Requirements

- GNOME Shell 50
- [AppIndicator and KStatusNotifierItem Support](https://extensions.gnome.org/extension/615/appindicator-support/) for most third-party tray applications

## Install

```bash
npm ci
npm run check
npm run pack
gnome-extensions install --force gnome-app-tray@radnotred.dev.shell-extension.zip
gnome-extensions enable gnome-app-tray@radnotred.dev
```

Log out and back in after installing or replacing JavaScript on Wayland. The checkout can also be symlinked directly to:

```text
~/.local/share/gnome-shell/extensions/gnome-app-tray@radnotred.dev
```

## Settings

Open the gear button in the flyout or run:

```bash
gnome-extensions prefs gnome-app-tray@radnotred.dev
```

The Appearance page controls columns and popup icon size. The Applications page chooses the default location and manages saved overrides. An application becomes available to add after GNOME has seen its indicator at least once.

## Safe development and testing

Run the complete isolated test suite without touching the logged-in desktop:

```bash
npm run test:headless
```

It starts a private headless GNOME Shell, opens the real preferences window, repeatedly adds and removes mock indicators, checks menu ownership and placement rules, disables AppIndicator while an icon is live, and reloads App Tray 20 times. A successful run prints `HEADLESS_INTEGRATION_OK`.

For a visible nested development session, install Mutter's development kit and launch the included wrapper:

```bash
sudo dnf install mutter-devkit
./tools/run-devkit.sh
```

GNOME caches loaded JavaScript modules, so changing a `.js` file requires closing and relaunching the development session. CSS and settings can be iterated separately, but a full restart is the reliable test for extension code.

To test fresh code against applications in the current logged-in session, use the cache-busting host-development launcher:

```bash
npm run dev:host
```

It disables the stable App Tray UUID, installs the checkout under a new temporary UUID, and removes that copy when you press `Ctrl+C`. Each run receives a new module path, so GNOME loads the current JavaScript without a logout. Only one host-development copy is kept at a time. If the terminal was interrupted before cleanup, run `npm run dev:host:stop`.

GNOME does not normally let a running Wayland Shell register local extension UUIDs. Before each host-development run, press `Alt+F2`, open `lg`, select the Evaluator tab, and run `global.context.unsafe_mode = true`. The launcher uses that access only to rescan local extensions and immediately turns unsafe mode off again.

Other development commands:

```bash
npm run check
npm run format
npm run pack
```

## Safety model

The AppIndicator extension remains the sole owner of each real panel actor and popup menu. App Tray creates its own icon buttons, collapses the original actor's panel allocation, and temporarily points an existing menu at the persistent tray arrow while it is open. It never reparents or destroys foreign actors and defers discovery changes until their owner has finished its lifecycle callback.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
