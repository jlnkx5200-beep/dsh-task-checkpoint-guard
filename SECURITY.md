# Security Policy

## Supported versions

Security fixes are prepared for the latest `0.1.x` release candidate. The project has not yet published a stable release or selected an open-source license.

## Reporting a vulnerability

Do **not** open a public issue for a vulnerability involving credentials, checkpoint disclosure, path traversal, arbitrary code execution, or a recovery policy that could cause unsafe tool execution.

Once the GitHub repository exists, use GitHub's **Private Vulnerability Reporting** feature for this repository. If that feature is not yet enabled, contact the repository owner through the private contact method listed on the GitHub profile; do not include secrets in the first message.

Include:

- affected version/commit;
- DSH and Node.js version;
- operating system;
- a minimal reproduction with synthetic data;
- whether a credential, checkpoint, or tool side effect is exposed;
- suggested mitigation, if known.

Never include real API keys, session IDs, prompts, checkpoints, logs, or user task content in a report. Redact them.

## Security model

### Trusted boundaries

- DSH host services and events are trusted.
- The local filesystem and checkpoint root are trusted to the extent that other local users/processes cannot tamper with them.
- A configured `probeUrl` is trusted operator input.
- The model can generate arbitrary visible text and tool arguments. Those are treated as untrusted data for persistence and redaction.

### Data stored locally

Checkpoint files may contain:

- the original human instruction and goal objective;
- visible assistant output;
- bounded, redacted tool argument previews and results;
- session/task/goal IDs;
- provider/model names;
- checkpoint status and recovery notes.

They are **not** intended for publication, issue attachments, or public logs. A checkpoint directory should be protected with the same care as DSH session history.

### Credentials

- API keys are resolved per probe through `ctx.credentials.resolve()`.
- Credential values are never written to checkpoint JSON/Markdown/pointers or recovery context.
- Bearer credentials are attached only to the configured probe request.
- Redirects are rejected to prevent forwarding credentials to another origin.
- Bearer probes require HTTPS unless the target host is loopback.
- Error messages are redacted before being stored or logged.

### Redaction limitations

Redaction uses heuristics for common credential shapes and secret-looking JSON keys. It cannot prove that arbitrary natural-language text contains no secret. Users must avoid placing credentials in prompts or tool arguments.

### Network behavior

The only outbound network request made by this plugin is the optional readiness probe. No checkpoint data is uploaded or synchronized. The probe sends a method, URL path, `Accept`, `User-Agent`, and optionally an authorization header; it never sends task state or a request body.

## Threat model and non-goals

The plugin is not a security boundary against:

- a malicious DSH host or plugin with direct process/filesystem access;
- a compromised local account that can read the checkpoint root;
- secrets embedded in arbitrary user text;
- side effects from tools that are not idempotent;
- two processes writing the same checkpoint root concurrently.

## Checkpoint integrity

- Unknown schema versions are rejected.
- Loaded documents are re-normalized and bounded.
- Task and pointer paths are derived from sanitized IDs; session pointers store relative paths.
- The previous valid copy is retained and loaded when the current copy is corrupt.
- Multi-process locking is not implemented; use one owning DSH process per checkpoint root/session.

## Dependency and API policy

- No npm runtime dependencies.
- No imports from private DSH packages or other plugins' private source files.
- Public DSH services/events only; see [docs/architecture.md](docs/architecture.md#public-api-dependencies).
- The DSH version range is declared in `package.json` and enforced by the DSH plugin loader.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).

MIT grants broad permission to use, copy, modify, and distribute the software,
but it does not grant trademark rights or imply endorsement by DeepSeek.
