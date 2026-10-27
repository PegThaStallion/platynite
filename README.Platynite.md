# Platynite

A Playnite-style TV library powered by Moonlight, installed beside your existing Moonlight app.

Based on BrightCraft Moonlight Tizen **1.19.0**, commit `4bb3134fd1a7ecfb5eb556b4f09583006748d180`. Original streaming code and licenses remain in this repository. See [upstream README](README.md), [GPL-3.0 license](LICENSE), and the component notices in their source directories.

## Installation

1. Install `PlatyniteCompanion.pext` in Playnite on the PC, then restart Playnite. Keep Playnite and Sunshine running.
2. Install the locally signed `Platynite.wgt` through Apps2Samsung. Platynite uses package `PlatyNite1`, app `PlatyNite1.Platynite`, and preview service `PlatyNite1.service`. These do not replace Moonlight's `MoonLightS` package.
3. In Playnite's Extensions menu, choose **Platynite → Show TV connection details**. On the TV, select **Connect Playnite** and enter the companion address and access token. A different Sunshine IPv4 address/hostname is optional.
4. Select an installed game and press **Play**. Pair Platynite with Sunshine using the PIN displayed on the TV. Its pairing is independent of your original Moonlight client.

Platynite opens Sunshine's existing **Desktop** application, waits for the stream to connect, then asks Playnite to launch the selected game. Uninstalled games stay visible with Play disabled. Hidden games are behind a filter. **Resume desktop** reconnects without issuing a game launch. Disconnecting does not quit the game.

The companion listens on TCP 19822. Allow access from your trusted local network if Windows Firewall blocks the connection. The access token remains in Playnite's plugin data directory and the TV's private application storage; do not commit it or include it in build artifacts.

## Building

The `Platynite build` GitHub Actions workflow compiles the original WASM engine using the upstream Samsung Emscripten Docker toolchain, assembles an unsigned widget, and builds the companion on Windows against the official Playnite SDK. Download both workflow artifacts. CI never receives your signing certificates.

For a local companion build, run `tools/build-companion.ps1` in PowerShell, using `-PlaynitePath` if necessary. It uses the Windows .NET Framework compiler and your installed Playnite SDK; no system PATH changes are required.

For a full streaming-engine build: `docker build -t platynite-build .`; copy `/home/moonlight/Platynite.wgt` out of the resulting image, then run `python tools/build-widget.py --engine <compiled.wgt>`. For UI-only development, the unchanged engine from BrightCraft's v1.19.0 release can also be supplied; its archive hash is recorded in `BUILD.json`.

Sign the widget locally using `tools/sign-widget.ps1 -Package <Platynite.wgt> -Signer <TizenSdb.exe>`. This uses the same open-source signing implementation as Apps2Samsung, from [PatrickSt1991/tizen-sdb](https://github.com/PatrickSt1991/tizen-sdb), and reuses the compatible Apps2Samsung Partner certificate by default. The helper reads the password locally and does not print it. A different certificate directory may be supplied.

Install with `apps2samsung-cli install <Platynite.wgt> --tv <TV_IP>`. Keep the fixed package ID for updates; do not pass removal options targeting Moonlight.

## Checks

- `node --test tests/frontend.test.cjs` validates frontend syntax, distinct app/service identities, and streaming event integration.
- `node tools/browser-test.cjs` uses Playwright for library/filter/offline, remote/gamepad focus, deferred launch, duplicate prevention, and resume checks. It uses a fake streaming engine and never launches a real game. Set `BROWSER_EXE` to a local Chromium/Edge executable if needed.
- `tools/test-companion.ps1` exercises the actual HTTP parser and API boundary with a non-launching fixture. Supply `-Python` if Python is not on PATH.
- `python tools/verify-widget.py <Platynite.wgt>` verifies XML signatures, package file digests, and package identity; requires lxml and cryptography.

Hardware verification still needs Sunshine pairing, a real stream, and a physical controller/audio check. Default streaming settings are inherited from Moonlight; start with 1080p60 SDR.

## Companion API, version 1

All routes require `Authorization: Bearer <token>` except OPTIONS preflight. HTTP errors are JSON with an `error` string.

- `GET /api/catalog`: `{version:1, updatedAt, host, games:[...]}`. Each game contains its Playnite UUID, name, installed/hidden/favorite/running/launching flags, description, playtime, last activity, platforms, source, artwork paths, and artwork version.
- `GET /api/artwork/<game UUID>/cover` or `/background`: resized JPEG, or 404 when unavailable. No arbitrary file paths are accepted.
- `POST /api/launch`: `{id:<game UUID>, requestId:<request UUID>}`. Rejects unknown/uninstalled games and conflicts with another running game. Reusing a request ID or requesting a game already running/launching does not launch another copy. Returns `launch-requested`, `already-running`, or `already-requested`.

## Rollback

Uninstall **Platynite** (`PlatyNite1.Platynite`) only. Remove **Platynite Companion** through Playnite's Add-ons manager and restart Playnite. Neither step changes the original Moonlight app or Sunshine configuration. Optional companion connection data is under `%APPDATA%\Playnite\ExtensionsData\7a36cbe2-014b-467a-99d5-cef25c692a15`; remove it to revoke the stored token after uninstalling.
