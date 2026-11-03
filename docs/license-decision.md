# License decision

**Decision: MIT.** The project is released under the MIT License, copyright
(c) 2026 jlnkx5200-beep. This document records the decision rationale and is not
legal advice.

The canonical license text is in [LICENSE](../LICENSE). `package.json` uses the
SPDX identifier `MIT`.

## Questions reviewed

1. Copyright is held by the project owner identified in `LICENSE`.
2. The implementation is original and does not vendor DSH or third-party code.
3. No employment or contract restriction was identified in the local audit.
4. External contributions are accepted under the MIT License as described in
   [CONTRIBUTING.md](../CONTRIBUTING.md).
5. Patent protection was not made a licensing requirement.
6. Downstream commercial and closed-source use is permitted by MIT.

## MIT (selected)

Typical characteristics:

- short and widely understood;
- permits commercial use, modification, distribution, and private use;
- requires preservation of the copyright and permission notice;
- includes a warranty disclaimer;
- does **not** include an explicit patent grant.

A common fit when the goal is maximum adoption with minimal compliance friction.
This is the license selected for this project.

## Apache-2.0 (not selected)

Typical characteristics:

- permits commercial use, modification, distribution, and private use;
- requires preservation of notices and includes NOTICE-file handling;
- includes an explicit patent grant and patent-termination language;
- requires marking modified files in some circumstances;
- includes a warranty disclaimer and limitation of liability.

A common fit when explicit patent protection and a more formal contribution/governance posture matter more than minimal license text.

## Other options

- **GPL-3.0 / AGPL-3.0:** strong copyleft; materially changes distribution obligations and may be unsuitable for plugin ecosystems that expect permissive licensing.
- **Dual licensing:** requires separate commercial terms and legal review.
- **Proprietary/source-available:** not open source by the usual definition; the repository would need an explicit custom license.

## Applied process

1. Copyright holder recorded as `jlnkx5200-beep`.
2. No copied or incompatible third-party code was identified in the audit.
3. MIT was selected by the project owner.
4. `LICENSE` now contains the canonical MIT text.
5. `package.json` and `package-lock.json` use the `MIT` SPDX identifier.
6. README, SECURITY, CONTRIBUTING, release notes, and release documentation
   were updated to reference MIT.
7. No `NOTICE` file is required by the selected MIT license.
8. The release checklist and package were revalidated before publication.
