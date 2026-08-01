#!/usr/bin/python3
"""Small StatusNotifierItem used by the isolated GNOME Shell test harness."""

import argparse
import signal

import gi

gi.require_version("AyatanaAppIndicator3", "0.1")
gi.require_version("Gtk", "3.0")

from gi.repository import AyatanaAppIndicator3 as AppIndicator  # noqa: E402
from gi.repository import GLib, Gtk  # noqa: E402


class MockIndicator:
    def __init__(self, indicator_id: str, title: str, icon: str, lifetime: int):
        self._indicator_id = indicator_id
        self._title = title
        self._icon = icon
        self._lifetime = lifetime
        self._indicator = None
        self._menu = None

    def start(self):
        self._indicator = AppIndicator.Indicator.new(
            self._indicator_id,
            self._icon,
            AppIndicator.IndicatorCategory.APPLICATION_STATUS,
        )
        self._indicator.set_title(self._title)

        self._menu = Gtk.Menu()

        action_item = Gtk.MenuItem(label="Mock action")
        action_item.connect("activate", self._on_action)
        self._menu.append(action_item)

        attention_item = Gtk.CheckMenuItem(label="Needs attention")
        attention_item.connect("toggled", self._on_attention_toggled)
        self._menu.append(attention_item)

        self._menu.append(Gtk.SeparatorMenuItem())

        remove_item = Gtk.MenuItem(label="Remove mock indicator")
        remove_item.connect("activate", lambda _item: self.stop())
        self._menu.append(remove_item)

        self._menu.show_all()
        self._indicator.set_menu(self._menu)
        self._indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        print(f"MOCK_INDICATOR_ADDED id={self._indicator_id}", flush=True)

        if self._lifetime > 0:
            GLib.timeout_add_seconds(self._lifetime, self.stop)

        return GLib.SOURCE_REMOVE

    def _on_action(self, _item):
        print(f"MOCK_INDICATOR_ACTION id={self._indicator_id}", flush=True)

    def _on_attention_toggled(self, item):
        status = (
            AppIndicator.IndicatorStatus.ATTENTION
            if item.get_active()
            else AppIndicator.IndicatorStatus.ACTIVE
        )
        self._indicator.set_status(status)
        print(
            f"MOCK_INDICATOR_ATTENTION id={self._indicator_id} active={item.get_active()}",
            flush=True,
        )

    def stop(self):
        if self._indicator is None:
            GLib.idle_add(self._quit)
            return GLib.SOURCE_REMOVE

        self._indicator.set_status(AppIndicator.IndicatorStatus.PASSIVE)
        self._indicator = None
        self._menu = None
        print(f"MOCK_INDICATOR_REMOVED id={self._indicator_id}", flush=True)
        GLib.timeout_add(250, self._quit)
        return GLib.SOURCE_REMOVE

    @staticmethod
    def _quit():
        Gtk.main_quit()
        return GLib.SOURCE_REMOVE


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", default="gnome-app-tray-mock")
    parser.add_argument("--title", default="App Tray Test")
    parser.add_argument("--icon", default="utilities-terminal")
    parser.add_argument(
        "--delay",
        type=int,
        default=3,
        help="Seconds to wait before registering the indicator",
    )
    parser.add_argument(
        "--lifetime",
        type=int,
        default=5,
        help="Seconds to keep the indicator alive after registration; 0 waits forever",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    mock = MockIndicator(args.id, args.title, args.icon, args.lifetime)

    signal.signal(signal.SIGINT, lambda _signum, _frame: mock.stop())
    signal.signal(signal.SIGTERM, lambda _signum, _frame: mock.stop())

    if args.delay > 0:
        GLib.timeout_add_seconds(args.delay, mock.start)
    else:
        GLib.idle_add(mock.start)
    Gtk.main()


if __name__ == "__main__":
    main()
