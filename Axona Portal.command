#!/bin/bash
# Double-click this file in Finder to start axona.portal.
#
# A ".command" opens in Terminal, which is deliberate for the plain launcher:
# the window is both the log and the off switch — close it (or press ^C) and
# the portal leaves the mesh cleanly. For a Terminal-free icon in the Dock,
# run scripts/make-macos-app.sh once and use the .app it builds instead.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/launch.sh"
