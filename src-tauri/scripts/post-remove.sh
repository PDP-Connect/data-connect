#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Re-index after removing the .desktop file.
update-desktop-database -q /usr/share/applications || true

# Unload the bundled Chromium's AppArmor profile. dpkg has already removed the
# profile file, so remove the loaded profile by name. An upgrade keeps it:
# the new package's post-install script reloads it.
apparmor_sysfs="${DATACONNECT_APPARMOR_SYSFS:-/sys/kernel/security/apparmor}"
apparmor_profile="${DATACONNECT_APPARMOR_PROFILE:-/etc/apparmor.d/dataconnect-chromium}"
case "$1" in
  remove|purge)
    if [ -w "$apparmor_sysfs/.remove" ] && grep -q '^dataconnect-chromium ' "$apparmor_sysfs/profiles" 2>/dev/null; then
      printf '%s' dataconnect-chromium > "$apparmor_sysfs/.remove" || true
    fi
    rm -f "$apparmor_profile"
    ;;
esac
