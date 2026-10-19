# Clean-setup checks of the judge's path (NIV-16)

The live acceptance (NIV-14) ran on Nate's PC, which has every tool installed. These checks follow a judge instead: the
files published on the release, the README's steps, and setups that never had Nivra, its runtime or its settings.

- Run them on the release under test: today, the
  [v0.1.1 pre-release](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases/tag/v0.1.1).
- Record what happened, including anything the README got wrong or left out. A check that isn't run is recorded as not
  run.
- **The key** is the judges' key (Nate's existing Token Factory key, D24). Paste it only into Nivra's Settings, never
  into a terminal, a file or a chat. When a check ends, press **Remove** under Settings, then delete the setup.

## 1. Windows → WSL, as a fresh Windows user

**The setup:** a new local account on Nate's PC (Windows 11 Home). It gets its own WSL distribution, its own Nivra
settings and WSL's default networking. The machine is shared, so the Visual C++ runtime is installed and Smart App
Control is off: this check covers neither (see check 3, and the README).

1. In your own account, open Terminal as administrator and run `net user nivrajudge * /add`; it asks for a password
   twice. Switch to `nivrajudge` (Start → your picture) and sign in. Your own session can stay signed in.
2. In Edge, open the release and download `Nivra-0.1.1-win-x64.zip` and `SHA256SUMS`. In PowerShell:
   ```powershell
   Get-FileHash $HOME\Downloads\Nivra-0.1.1-win-x64.zip
   Get-Content $HOME\Downloads\SHA256SUMS
   ```
   The hash must match the zip's line (`Get-FileHash` prints it in capitals). Record it.
3. In Explorer, right-click the zip → **Extract All…**, enter `C:\Users\nivrajudge\AppData\Local\Programs\Nivra`, and
   extract. Record how long it took, and any error.
4. Start `Nivra.exe` from that folder. Record whether SmartScreen asked (**More info → Run anyway**).
5. No distribution exists yet: record what Nivra says about WSL, word for word (expected: "WSL has no distribution
   Nivra can use", with what to do).
6. In PowerShell, run `wsl --install` (if it installs nothing, `wsl --install -d Ubuntu`) and create the Linux user it
   asks for. If Windows asks for administrator approval, give it and record that it asked. Then, in that Ubuntu shell:
   ```bash
   . /etc/os-release; echo "$PRETTY_NAME"; git --version
   ```
   Record both lines. Press **Check again** in Nivra, and record what changes.
7. Follow the README's [testing instructions](../README.md#testing-instructions) from step 2, as written. The folders
   are `\\wsl.localhost\<distribution>\home\<your Linux user>\…`. For each step, record whether it did what the README
   says, and copy any message Nivra showed word for word. Also record:
   - the label under Settings after **Save** (expected: "Key saved, encrypted");
   - how long the first **Add** took until the project was ready: Nivra installs its runtime into the new distribution;
   - the three results the README promises:
     - citations on valhalla-fitness's answer;
     - under **Conflicts**, nivra-demo-timer's convention governing over your personal default;
     - the task choice governing, with "Currently" still showing the repository's convention.

     If one is missing, explain once more. If it's still missing, record it as missing.
8. Press **Remove** under Settings, then quit Nivra. Remove it as the README says:
   - delete `%LOCALAPPDATA%\Programs\Nivra` and `%APPDATA%\Nivra`;
   - delete `%LOCALAPPDATA%\Nivra` if it exists, and record whether it did;
   - in Ubuntu, run `rm -rf ~/.nivra`.

   Then run `wsl --unregister Ubuntu` in PowerShell, using the name `wsl --list` shows.
9. Sign out. In your own account, go to Settings → Accounts → Other users → `nivrajudge` → **Remove** → **Delete
   account and data**.

## 2. The deb on a stock Ubuntu 24.04 desktop, AppArmor on

**The setup:** a live session from an Ubuntu 24.04 desktop USB stick ("Try Ubuntu"), or a fresh VirtualBox VM. It
can't be WSL, whose kernel has AppArmor off; that's why this check is still open.
- Windows 11 Home has no Hyper-V, so VirtualBox needs the Windows Hypervisor Platform feature turned on.
- To boot from USB, use the one-time boot menu and change no firmware setting. Keep your BitLocker recovery key at hand
  in case Windows asks for it afterwards.

1. Connect to the network and open Terminal. Record what this prints:
   ```bash
   lsb_release -ds; uname -r; cat /sys/module/apparmor/parameters/enabled; sysctl kernel.apparmor_restrict_unprivileged_userns
   ```
   Expected: Ubuntu 24.04.x LTS, `Y`, and `= 1`.
2. In Firefox, open the release and download `Nivra-0.1.1-amd64.deb` and `SHA256SUMS`. Then:
   ```bash
   cd ~/Downloads && sha256sum -c SHA256SUMS --ignore-missing && sha256sum Nivra-0.1.1-amd64.deb
   ```
   Expect `Nivra-0.1.1-amd64.deb: OK`. Record the hash.
3. Install it as the README says, after refreshing the package lists:
   ```bash
   sudo apt update && sudo apt install ./Nivra-0.1.1-amd64.deb
   ```
   Record any warning. apt's notice that the download "is performed unsandboxed as root" is harmless. git comes with
   the deb.
4. Record what the install set up for AppArmor and the Chromium sandbox:
   ```bash
   ls -l /etc/apparmor.d/nivra; sudo aa-status | grep -c nivra; stat -c '%a %U' /opt/Nivra/chrome-sandbox
   ```
   Expected: the profile, a count of 1 or more, and `755 root`.
5. Start Nivra from **Show Apps**, as a judge would, and record whether the window opens. If it doesn't, run `nivra` in
   Terminal and copy the first lines it prints.
6. Clone both repositories into `~`, then follow the README's testing instructions from step 2. Record as in check 1,
   step 7. In a live session, a keyring may ask for a new password when you save the key. Any password will do; record
   that it asked.
7. Press **Remove** under Settings and quit. Then run:
   ```bash
   sudo apt remove nivra && ls /opt/Nivra /etc/apparmor.d/nivra /usr/bin/nivra; rm -rf ~/.config/Nivra ~/.nivra
   ```
   `ls` should find none of them; record anything left. Shut the live session down (it keeps nothing), or delete the VM.

## 3. Folders on a Windows drive, without the Visual C++ redistributable

**Not run on a clean machine:** Windows 11 Home has no Windows Sandbox or Hyper-V, and this PC has the redistributable.
- **v0.1.0 would fail here.** Its runtime shipped `vcruntime140.dll` next to `node.exe`, where Windows never looks for
  an add-on's dependencies, so its native engine would stop at start (D25).
- **0.1.1 ships the DLL beside the add-on.** The controlled check on this PC passes: with the add-on's import renamed in
  a copy so that no installed runtime can satisfy it, the packaged engine starts, opens its databases and runs hello. The
  same check fails on v0.1.0. That is an experiment, not a clean machine ([acceptance.md](acceptance.md), *Release
  candidate 0.1.1*).

To check it for real, use a Windows PC or VM where `Test-Path C:\Windows\System32\vcruntime140.dll` prints `False`. Add
a folder on a Windows drive, press **Run hello**, then press **Run checks** under Doctor.

## Results

| Check | Setup | Release files | Date | Result |
|---|---|---|---|---|
| 1. Windows → WSL | a fresh WSL distribution and Nivra profile on Nate's account (see below) | `Nivra-0.1.1-win-x64.zip`, sha256 `df371719…a6d7783` | 19–20 October | **Passed**, 23 of 23 checks |
| 2. The deb, AppArmor on | an Ubuntu 24.04.5 desktop VM (see below) | `Nivra-0.1.1-amd64.deb`, sha256 `86da0745…d632d1ab` | 19 October | **Passed**, 22 of 22 checks |
| 3. Windows-drive folders, no Visual C++ redistributable | | | | *Not run*; the controlled check passes on 0.1.1 (see 3) |

### Check 1, 19–20 October

**The setup.** Nate has one Windows account, so instead of a new account the check used a fresh WSL distribution and a
fresh Nivra profile on his.
- **The distribution:** `NivraJudge`, installed beside his own as `wsl --install Ubuntu --name NivraJudge`. That gives
  Ubuntu 26.04.1 LTS, today's `wsl --install` default, on WSL 2.7.8.
- **The profile:** a new one, `--user-data-dir` in `%LOCALAPPDATA%\nivra-clean-check`. His own profile in
  `%APPDATA%\Nivra` was never touched.
- **Shared with his account:**
  - Windows 11 Home, build 26300;
  - the Visual C++ runtime;
  - Smart App Control, which is off;
  - mirrored networking, set in his `.wslconfig`.

**By hand (Nate)**
- **First run of the distribution:** he created the Linux user `renat`, then cloned both repositories there.
- **Download:** the zip, in Edge. `Get-FileHash` gave `DF371719…A6D7783`, matching `SHA256SUMS`.
- **Extraction:** **Extract All…**, to its own default, `Downloads\Nivra-0.1.1-win-x64`. That's 3,784 files. Its
  `app.asar` (`a6fdf4e5…`) and Windows runtime (`d7b773e6d952ca65`) are the candidate's.
- **SmartScreen** asked on the first double-click of the extracted `Nivra.exe`, and not again after **Run anyway**.
- **The key:** after it was saved, Settings said "Key saved, encrypted" (DPAPI).

**README steps 4–8, driven by Claude through Nivra's UI.** Nivra was started from a launcher with its fresh profile and
local debugging ports, and the steps ran as in check 2. Every check passed on the first attempt, with no retry:
- **The first Add** of a `\\wsl.localhost\NivraJudge\…` folder installed Nivra's runtime into the new distribution. The
  engine was online 5.6 s later.
- **valhalla-fitness** was explained in 104 s; 10 of 10 citations point to lines the model was shown.
- **nivra-demo-timer:**
  - the repository governs over the personal default;
  - both conflicts are ranked as their sides say;
  - valhalla-fitness's own preference is in neither its context nor its conflicts.
- **The task choice** governs "component file naming", with "Currently" showing the repository's convention, and
  `nivra.json` stayed byte-identical.
- **After the edit,** the next run received revision 2. After the delete, it received no preference.
- **The key** was then removed.
- **Usage:** 5 runs on `nvidia/nemotron-3-super-120b-a12b`, at least 234,104 tokens in and 14,579 out, over 34 calls and
  421 s.

**The removal.** The extracted folder and the test profile were deleted. `%LOCALAPPDATA%\Nivra` was never created, since
no native engine started. Unregistering the distribution removes its `~/.nivra`.

**Found along the way, both in WSL, not Nivra**
- **The systemd user session fails.** Opening Ubuntu 26.04.1 under WSL 2.7.8 printed "Failed to start the systemd user
  session". systemd couldn't spawn its executor ("Device or resource busy") on the unified cgroup hierarchy. Nivra starts
  its engine with `wsl.exe --exec`, which doesn't need that session, and it worked. Any judge on today's default Ubuntu
  would see the same warning.
- **Interop broke more than once.** Using `NivraJudge` from Nate's other distribution, or stopping it, unregistered
  WSL's Windows-interop handler there, so Windows programs stopped running from it until `sudo` re-registered the
  handler. Nivra starts its engines from Windows, so this doesn't affect it.

### Check 2, 19 October

**The setup**, since Nate's PC has no Hyper-V and no spare machine:
- a KVM virtual machine inside WSL, shown on the Windows desktop through WSLg;
- Ubuntu's 24.04 cloud image, checked against Ubuntu's signed `SHA256SUMS`, with `ubuntu-desktop-minimal` and
  `spice-vdagent` added by cloud-init;
- Ubuntu 24.04.5 LTS on its stock `6.8.0-147-generic` kernel, with AppArmor on and
  `kernel.apparmor_restrict_unprivileged_userns = 1`;
- a GNOME session on Wayland, with the Firefox snap.

**By hand (Nate):**
- downloading the deb and `SHA256SUMS` in Firefox, and `sha256sum -c` printing `OK`;
- `sudo apt update && sudo apt install ./Nivra-0.1.1-amd64.deb`;
- starting Nivra from Show Apps, adding valhalla-fitness, and saving the key;
- Settings said "Key saved, encrypted", kept in GNOME's keyring.

**Checked over SSH after the install**
- **The AppArmor profile** is at `/etc/apparmor.d/nivra`. The kernel had it loaded, in unconfined mode with user namespaces
  allowed.
- **`chrome-sandbox`** is `755 root`, not setuid.
- **Chromium's sandbox is on.** The renderer and the sandboxed helper processes run in their own user namespace, and the
  renderer has seccomp filtering. No process runs with `--no-sandbox`.

**README steps 4–8, driven by Claude through Nivra's UI.** Nivra was restarted with a debugging port on the VM's
localhost, and the steps were run with the acceptance harness's UI helpers and scoring (`scripts/live-ui.ts`). Every check
passed on the first attempt, with no retry:
- **valhalla-fitness** was explained in 212 s; 5 of 5 citations point to lines the model was shown.
- **The two preferences** were confirmed.
- **nivra-demo-timer:**
  - the repository governs over the personal default;
  - both conflicts are ranked as their sides say;
  - valhalla-fitness's own preference is in neither its context nor its conflicts.
- **The task choice** governs "component file naming", with "Currently" showing the repository's convention, and
  `nivra.json` stayed byte-identical.
- **After the edit,** the next run received revision 2. After the delete, it received no preference.
- **The key** was then removed, and Settings said so.
- **Usage:** 5 runs on `nvidia/nemotron-3-super-120b-a12b`, at least 197,726 tokens in and 14,290 out, over 32 calls and
  533 s.

**The removal, as the README says it**
- `sudo apt remove nivra` removed `/opt/Nivra`, the AppArmor profile and `/usr/bin/nivra`, and the profile was unloaded.
- `rm -rf ~/.config/Nivra ~/.nivra` removed the rest.
- apt printed two harmless `update-alternatives` warnings, because electron-builder's removal script runs after the files
  are gone. dpkg lists the package as removed (`rc`) until `apt purge`.

**Ways this differed from a judge's machine**
- The VM is a cloud image with the minimal desktop added, not an installation from the desktop ISO.
- The VM's window couldn't share the clipboard, so the key went from the Windows clipboard to the VM's over SSH, through a
  pipe that printed nothing.
- For the test, screen blanking, locking and automatic suspend were turned off.

**Found along the way**
- **The window can stay hidden.** Nivra was launched over SSH while GNOME's screen was locked, and its window never
  appeared: it is created hidden and shown on `ready-to-show`, which never fired. Showing it from the main process
  worked. A follow-up is proposed: show the window after a timeout as well.
- **A login prompt from `git clone`.** One clone asked for GitHub credentials, likely from a mistyped URL. Both
  repositories are public and clone without a login.
