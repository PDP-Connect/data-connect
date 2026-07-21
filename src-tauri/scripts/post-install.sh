#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Index the .desktop file so the x-scheme-handler/vana MIME type is registered.
update-desktop-database -q /usr/share/applications || true
