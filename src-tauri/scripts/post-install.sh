#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Index the .desktop file so the x-scheme-handler/vana MIME type is registered.
update-desktop-database -q /usr/share/applications || true

# Load the AppArmor profile that lets the bundled Chromium create its sandbox
# on Ubuntu 23.10+. Skip it when AppArmor is not in use; never fail the install.
apparmor_sysfs="${DATACONNECT_APPARMOR_SYSFS:-/sys/kernel/security/apparmor}"
apparmor_profile="${DATACONNECT_APPARMOR_PROFILE:-/etc/apparmor.d/dataconnect-chromium}"
if [ -d "$apparmor_sysfs" ] && [ -f "$apparmor_profile" ] && command -v apparmor_parser >/dev/null 2>&1; then
  apparmor_parser -r "$apparmor_profile" || true
fi
