#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Re-index after removing the .desktop file.
update-desktop-database -q /usr/share/applications || true
