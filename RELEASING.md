# Releasing PoolTerminal

The pre-build checklist. Every item below exists because skipping it once
nearly shipped (or did ship) something it exists to catch. Run it top to
bottom before `npm run build`.

## 1. Demo-isolation leak tour — MANDATORY before any build

Demo mode must show no real values, even after a live session has filled every
cache. The runtime gates cover the data plane, but three classes are
unenforceable at runtime and only a walk-through catches them: view-local
caches, user config echoed into the UI, and literals baked into source from
dev captures. Real leaks of all three classes shipped in 0.1.0–0.3.2.

Run the harness (`src/dev/leak-tour.js`):

1. Start the app (dev or a packaged build — auditing the actual release
   artifact is better). Open the webview devtools console.
2. Arm it, including the real values of the machine you develop on — this is
   what catches config echoes and pasted log lines:

   ```js
   localStorage.setItem('poolterminal.dev.leaktour', '1')
   localStorage.setItem('poolterminal.dev.leaktour.terms', JSON.stringify([
     'GNP1', 'cnode_bp', '192.168.0.62',      // ticker, unit names, hosts
     'russell',                                // usernames, home paths
     'stake1u8ru2', 'pool1fv9f8',              // real address/pool prefixes
   ]))
   ```

3. Reload. The tour simulates a live session with sentinel data, flips to
   demo inside every cache TTL, walks every tab, and DOM-scans each one. It
   ends on a full-screen PASS/FAIL report (also saved to
   `localStorage['poolterminal.dev.leaktour.report']`) and disarms itself.
4. **Any FAIL blocks the release.** A flagged invoke count > 0 means demo
   reached a node/API/cache command and also blocks.

Notes on reading the result:

- Agreed-legitimate brand strings (the tickertape link, the app identifier,
  the demo metadata-feed messages) are stripped before matching via the
  `ALLOWLIST` in `src/dev/leak-tour.js`, so terms like `GNP1` stay useful —
  they flag any occurrence *outside* those agreed spots. Never "fix" a FAIL
  by adding a bare term to the allowlist; only exact agreed strings belong
  there.
- On a live-connected install, calls in the "excluded (live-collector tail)"
  line are the live session's in-flight backfill draining during the
  post-flip grace window — collectors quiesce on the mode flip
  (collector-quiesce-v105), so this number should be small. A large number
  there, or any flagged count after it, is a finding, not noise.

## 2. Personal-values sweep

Defaults, placeholders and demo samples must be generic. Real values shipped
here before: the dev BP's IP and username as connect-modal defaults, custom
`cnode_bp` paths as stock defaults, a real delegator's stake address in a
smoke test, and real journal lines (real slots, PIDs, ideal/luck) as Logs
demo samples.

```bash
grep -rn "192\.168\.0\.\|russell\|cnode_bp" src/ src-tauri/src/ \
  --include='*.js' --include='*.rs' --include='*.html'
grep -rEn "stake1u[a-z0-9]{40,}|addr1[a-z0-9]{40,}|pool1[a-z0-9]{40,}" src/ \
  | grep -v "demo\|leak\|example\|xxxx"
```

Every hit must be either generated demo data, an agreed brand reference
(tickertape link, `com.gnp1.poolterminal` identifier, narrative comments,
demo metadata-feed messages), or it goes.

## 3. Version sync

`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml` must carry the same version. The UI reads its version
from the binary at runtime (`plugin:app|version`) — never hardcode a version
string in `src/`.

## 4. CHANGELOG.md

Entry for the new version, matching what the website's What's-New section
will say.

## 5. Build & publish

```bash
npm run build          # deb + AppImage under src-tauri/target/release/bundle/
sha256sum PoolTerminal_X.Y.Z_amd64.deb PoolTerminal_X.Y.Z_amd64.AppImage > SHA256SUMS
# Release body = the beta / no-warranty header + this version's CHANGELOG entry.
# The header is mandatory and goes FIRST, above the changelog and asset list.
cat .github/RELEASE_NOTES_HEADER.md CHANGELOG-entry-X.Y.Z.md > RELEASE_NOTES.md
gh release create vX.Y.Z --target main --notes-file RELEASE_NOTES.md ...   # git push is done by the operator, not tooling
```

Every release body starts with `.github/RELEASE_NOTES_HEADER.md` verbatim (the
same notice as the README beta box and the website). Edit the header there if
the wording changes; all seven existing releases were backfilled with it on
13 September 2026. Attach both artifacts and SHA256SUMS. Download links on the website point at
`/releases/latest`, so the release must be published before the site changes
go live.

## 6. Website

Update server-tools.grahamsnumberplus1.com/PoolTerminal/: audit every page for
version references (do not blanket-sed — historical changelog entries stay),
add the What's-New section, keep download hrefs on `/releases/latest`.
Backups go to `~/site-backups/`, never into the webroot.

## 7. Hard-fork check (era-sensitive releases only)

If the release window is near a fork, run the HARDFORK.md checklist and grep
for `// HARDFORK:` markers.
