# Clean-setup checks of the judge's path (NIV-16)

The live acceptance (NIV-14) ran on Nate's PC, which has every tool installed. These checks follow a judge instead: the
files published on the release, the README's steps, and setups that never had Nivra, its runtime or its settings.

- Run them on the release under test: today, the
  [v0.1.0 pre-release](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases/tag/v0.1.0).
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
2. In Edge, open the release and download `Nivra-0.1.0-win-x64.zip` and `SHA256SUMS`. In PowerShell:
   ```powershell
   Get-FileHash $HOME\Downloads\Nivra-0.1.0-win-x64.zip
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
2. In Firefox, open the release and download `Nivra-0.1.0-amd64.deb` and `SHA256SUMS`. Then:
   ```bash
   cd ~/Downloads && sha256sum -c SHA256SUMS --ignore-missing && sha256sum Nivra-0.1.0-amd64.deb
   ```
   Expect `Nivra-0.1.0-amd64.deb: OK`. Record the hash.
3. Install it as the README says, after refreshing the package lists:
   ```bash
   sudo apt update && sudo apt install ./Nivra-0.1.0-amd64.deb
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

**Not run on a clean machine:** Windows 11 Home has no Windows Sandbox. An experiment on 19 October shows that, as
built, it would fail:
- **The import.** libsql's Windows add-on imports `VCRUNTIME140.dll`. `node.exe` links its C runtime statically, so
  nothing has loaded that DLL before the add-on.
- **Where Windows looks.** The runtime ships the DLL next to `node.exe` (D6). Node loads an add-on with
  `LOAD_WITH_ALTERED_SEARCH_PATH`. Windows then looks in this order:
  1. the add-on's own folder;
  2. System32 and the Windows folder;
  3. the working directory;
  4. `Path`.

  It never looks in `node.exe`'s folder. The native engine's working directory is its home.
- **The experiment.** The add-on's import was renamed so that only the shipped copy could satisfy it.
  - With the DLL next to `node.exe`, loading failed: "The specified module could not be found."
  - With the DLL next to the add-on, or with the working directory in `node.exe`'s folder, it loaded.
- **What would happen.** The engine imports libsql when it starts. On a PC without the redistributable, the native
  engine would therefore stop at start with a runtime error.
- **Why the earlier checks passed.** Every PC used so far has `vcruntime140.dll` in System32, so `verify:windows` and
  `test:windows` passed.
- **What isn't affected.** WSL engines and the Linux build don't use this add-on build. The judges' instructions use
  WSL folders only.

To check it, use a Windows PC or VM where `Test-Path C:\Windows\System32\vcruntime140.dll` prints `False`. Add a folder
on a Windows drive, press **Run hello**, then press **Run checks** under Doctor.

## Results

| Check | Setup | Release files | Date | Result |
|---|---|---|---|---|
| 1. Windows → WSL | a fresh local user on Nate's PC | | | *Not run* |
| 2. The deb, AppArmor on | | | | *Not run* |
| 3. Windows-drive folders, no Visual C++ redistributable | | | | *Not run*; expected to fail as built (see 3) |
