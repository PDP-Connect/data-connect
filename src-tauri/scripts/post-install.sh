#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Index the .desktop file so the x-scheme-handler/vana MIME type is registered.
update-desktop-database -q /usr/share/applications || true

# Install and load the AppArmor profile that lets the bundled Chromium create
# its sandbox on Ubuntu 23.10+. Install it only when this system's parser
# accepts it (AppArmor 3.x has no userns rule, and a profile that does not
# parse fails apparmor.service at boot). Never fail the install.
apparmor_sysfs="${DATACONNECT_APPARMOR_SYSFS:-/sys/kernel/security/apparmor}"
apparmor_source="${DATACONNECT_APPARMOR_SOURCE:-/usr/share/data-connect/apparmor/dataconnect-chromium}"
apparmor_profile="${DATACONNECT_APPARMOR_PROFILE:-/etc/apparmor.d/dataconnect-chromium}"
if [ -d "$apparmor_sysfs" ] && [ -f "$apparmor_source" ] && command -v apparmor_parser >/dev/null 2>&1 \
  && apparmor_parser -Q -K "$apparmor_source" >/dev/null 2>&1; then
  cp "$apparmor_source" "$apparmor_profile" && apparmor_parser -r "$apparmor_profile" || true
fi
