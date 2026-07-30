# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/CodeByKeegan/splat-studio/security/advisories/new)
rather than opening a public issue. If that page is unavailable, email the
maintainer at the contact address in
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Trust model

Splat Studio is a desktop tool for a single, trusted local user:

- The API server binds to `127.0.0.1` only and validates `Host`/`Origin` headers
  (defense against CSRF and DNS rebinding from web pages), but it is
  **unauthenticated by design**: any process running as the same OS user can call
  it — including endpoints that write and delete workspace files, repoint the
  workspace root, and spawn conversion jobs. Don't run it on a machine whose
  other local processes/users you don't trust.
- **`.mjs` generators are code.** The server executes generator modules found in
  the workspace (in a child Node process with a timeout) to read their parameter
  schema and to synthesize splats. Only add generators you trust.
- **Auto-updates are not code-signed.** Updates are fetched over HTTPS from
  GitHub Releases and integrity-checked with electron-updater's SHA-512
  checksums, but the builds carry no Authenticode signature — update integrity
  ultimately rests on the GitHub account and release pipeline (signing is on the
  [roadmap](ROADMAP.md)).

Ways for a remote page — or anything outside that trust model — to drive the
server without the user's consent are in scope for reports.

This is a solo-maintained project — reports are acknowledged as soon as possible;
please allow reasonable time for a fix before public disclosure.
