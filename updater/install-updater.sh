#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=/opt/iw4x-anticheat-updater
CONFIG_PATH=/etc/iw4x-anticheat-updater.json

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this installer as root." >&2
    exit 1
fi

install -d -m 0755 "$INSTALL_DIR"
install -m 0755 "$SCRIPT_DIR/anticheat-updater.py" "$INSTALL_DIR/anticheat-updater.py"

if [ ! -e "$CONFIG_PATH" ]; then
    install -m 0640 "$SCRIPT_DIR/iw4x-anticheat-updater.example.json" "$CONFIG_PATH"
    echo "Created $CONFIG_PATH. Edit its destination paths before enabling the timer."
fi

install -m 0644 "$SCRIPT_DIR/../systemd/iw4x-anticheat-updater.service" /etc/systemd/system/iw4x-anticheat-updater.service
install -m 0644 "$SCRIPT_DIR/../systemd/iw4x-anticheat-updater.timer" /etc/systemd/system/iw4x-anticheat-updater.timer
systemctl daemon-reload

echo "Updater installed. Next:"
echo "  1. Edit $CONFIG_PATH"
echo "  2. Test: $INSTALL_DIR/anticheat-updater.py --check"
echo "  3. Enable: systemctl enable --now iw4x-anticheat-updater.timer"
