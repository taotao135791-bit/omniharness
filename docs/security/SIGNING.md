# Code Signing & Notarization Pipeline

OmniHarness ships unsigned test builds by default; the signing pipeline is fully
scripted and activates when certificates are present. Nothing in the release flow
*requires* secrets to be committed anywhere.

## macOS

1. Prerequisites (developer machine or CI secrets):
   - `MAC_CERT_P12` (base64 Developer ID Application certificate) + `MAC_CERT_PASSWORD`
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (notarization)
2. `electron-builder.yml` already sets `hardenedRuntime: true`. With
   `CSC_LINK`/`CSC_KEY_PASSWORD` env vars set, electron-builder signs automatically.
3. Notarize: `xcrun notarytool submit <dmg> --apple-id ... --team-id ... --wait`,
   then `xcrun stapler staple <dmg>`.
4. Verify: `spctl -a -vv <app>` and `codesign --verify --deep --strict <app>`.
   `scripts/verify/installer-smoke.mjs` runs these when artifacts exist.

## Windows

1. `WINDOWS_CERT_PFX` + `WINDOWS_CERT_PASSWORD` (EV or standard Authenticode).
2. electron-builder signs NSIS via `signtool` when `CSC_LINK` is set.
3. Verify: `signtool verify /pa <installer.exe>`.

## Linux

No binary signing convention; provide SHA-256 sums (`release-sha256.txt`) and a
detached GPG signature over the sums (`gpg --detach-sign`) in CI.

## Reproducibility

- Lockfile (`pnpm-lock.yaml`) is committed; CI builds with `pnpm install --frozen-lockfile`.
- Build inputs: Node LTS version pinned in `.nvmrc`, electron version pinned in
  `apps/desktop/package.json`.
- Two clean builds of the same commit must produce identical tarball SHA-256
  (checked by `scripts/verify/reproducible-build.mjs` — runs build twice, compares).

## SBOM

`scripts/release/sbom.mjs` walks `pnpm list --prod --json` plus electron-builder
metadata and emits CycloneDX JSON next to each installer as `sbom.cyclonedx.json`.
