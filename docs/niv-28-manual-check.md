# Locked GNOME startup check (NIV-28)

The five-second visibility fallback is merged through PR53. Ordinary Linux and Windows startup tests do not prove
the original failure is fixed: the remaining check starts a packaged app while a GNOME Wayland session is locked.
This procedure is unexecuted; it is not acceptance evidence.

## Prerequisites

- Ubuntu 24.04 with a GNOME Wayland desktop, on a physical machine or a VM. WSLg and locking the Windows host are
  different cases. In the guest's desktop terminal, `echo "$XDG_SESSION_TYPE"` must print `wayland`.
- A packaged Nivra build containing PR53's fix, with its source commit recorded. The historical v0.1.1 deb predates
  the fix. The command below assumes the package installs `/opt/Nivra/nivra`; confirm that file exists first.
- Close existing Nivra windows in the guest. No credentials, model calls or repository uploads are needed.

Use the guest's own desktop terminal. The temporary folder below has private permissions and supplies both an
isolated app profile and an isolated engine home. It does not use the normal release or development homes.

## Start while locked

Schedule the app to start after 15 seconds:

```bash
trial=$(mktemp -d "$HOME/nivra-niv28.XXXXXX")
unit="nivra-niv28-$$"

systemd-run --user --unit="$unit" \
  --on-active=15s --timer-property=AccuracySec=1s --collect \
  --setenv=DISPLAY="$DISPLAY" \
  --setenv=WAYLAND_DISPLAY="$WAYLAND_DISPLAY" \
  --setenv=XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  --setenv=DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  /opt/Nivra/nivra \
  --user-data-dir="$trial/profile" \
  --nivra-engine-home="$trial/engine"
```

Immediately lock the **guest** using Super+L. Stay locked for 30 seconds, then unlock. This gives the scheduled
launch and five-second fallback time to run. If launch was delayed until after unlock, the attempt is inconclusive.
Do not change the Chromium platform flags, disable its sandbox, relaunch the app or manually reveal its window to
make the check pass.

Pass only if Nivra's window is visible after unlocking and responds to normal interaction, such as opening Settings.
Also check an ordinary unlocked launch with a fresh isolated profile. Close the app normally after each check.

## Record the result

Before closing the app, retain the launch timing and logs:

```bash
sha256sum /opt/Nivra/resources/app.asar
systemctl --user show "$unit.service" \
  -p ActiveState -p SubState -p ExecMainStartTimestampMonotonic
journalctl --user -u "$unit.service" -o short-monotonic --no-pager
```

Record the source commit, package checksum, app checksum, Ubuntu/GNOME versions, Wayland session confirmation,
launch time, confirmation that it was locked during startup, time spent locked, screenshot after unlocking and the
interaction result. Check that the process exited after closing. Keep the temporary profile and logs with the
evidence until reviewed.

If the guest or a suitable packaged build is unavailable, leave the locked-session result pending. A passing mock,
WSLg check or Windows check must not be substituted for it.
