# FINAL-PUBLISH-CHECKLIST

**Project:** `dsh-task-checkpoint-guard`
**Version:** `0.1.0`
**License:** MIT
**Target repository:** <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard>

This file records the clean re-publication gate. It is not a license grant.

## 1. Privacy and ownership

- [x] All published content uses the pseudonymous GitHub handle
  `jlnkx5200-beep`; no real name or personal email address is used.
- [x] `LICENSE` copyright line:
  `Copyright (c) 2026 jlnkx5200-beep`.
- [x] `package.json` author and repository metadata use
  `jlnkx5200-beep` only.
- [x] README, README.zh-CN, release notes, license decision, release report,
  release checklist, and this file contain no real name, campus email, private
  email, or old GitHub account reference.
- [x] The previous public artifact was revoked: its repository was made private
  and its release and tag were deleted before the clean rebuild.
- [x] The old local Git history, old tarballs, release candidates, and
  temporary publication evidence were removed.
- [x] A fresh Git history will use only the pseudonymous GitHub handle and
  GitHub's privacy no-reply address; no personal email is stored in project
  metadata.
- [x] No third-party runtime, development, peer, optional, or bundled
  dependencies are present.
- [x] DSH core is MIT-licensed and no DSH source code is vendored.

## 2. Package privacy checks

- [x] Rebuilt the npm tarball from the sanitized tree.
- [x] Sanitized package SHA-256:
  `9ee63e2dc9eb573700e5dbda08de5e74593120da10c89406a9621424547fa470`.
- [x] Sanitized package size: `53,161` bytes.
- [x] Verified the tarball contains 19 files and the expected entry point.
- [x] Verified the tarball contains no real name, personal email, old account,
  absolute path, credential, session, checkpoint, log, or private key.
- [x] Verified the package imports as a Cordis plugin.
- [x] Ran the full 52-test suite with `DSH_CHECKOUT`.
- [x] Installed, composed, and removed the tarball in a disposable DSH profile.

## 3. Git and GitHub publication

- [x] Authenticated the `jlnkx5200-beep` GitHub account with an explicit,
  user-authorized device flow.
- [x] Created the public repository
  `jlnkx5200-beep/dsh-task-checkpoint-guard`.
- [x] Pushed a single clean initial commit `1a525a40be075ed817b3e8b8b93e4bc6b1050fb8`.
- [x] Confirmed the remote tree contains no removed identity data.
- [x] Verified GitHub Actions on Ubuntu/Windows and Node 22.19/24:
  <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/actions/runs/41583585417>
- [ ] Create tag `v0.1.0` and a GitHub Release.
- [ ] Attach the new tarball and `.sha256` asset.
- [ ] Download the release asset and verify its SHA-256.

## 4. GitHub security controls

- [x] Secret scanning and push protection enabled.
- [x] Private vulnerability reporting enabled.
- [x] Dependabot security updates enabled.
- [x] Actions restricted to selected GitHub-owned actions and SHA pinning.
- [x] `main` protected against force push/deletion, including admins.
- [ ] `v*` tag ruleset protects release tags with no bypass actors.
- [x] Confirmed no extra collaborators, deploy keys, webhooks, or Actions secrets.

## 5. Deferred

- [ ] Real-model recovery drill with a disposable provider credential.
- [ ] npm publication (separate explicit decision).
- [ ] Permanent deletion of the revoked private repository requires an
  old-account credential with repository-deletion permission or manual action
  in that account.

## 6. Publication record

- Initial commit: `1a525a40be075ed817b3e8b8b93e4bc6b1050fb8`
- GitHub Actions run:
  <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/actions/runs/41583585417>
- Tag: `v0.1.0` (pending)
- Release: (pending)
- Released asset SHA-256:
  `9ee63e2dc9eb573700e5dbda08de5e74593120da10c89406a9621424547fa470`
