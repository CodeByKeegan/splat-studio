# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/CodeByKeegan/splat-studio/security/advisories/new)
rather than opening a public issue.

Splat Studio runs a local HTTP server bound to `127.0.0.1` that can read and write
files and spawn processes. Ways for a remote page or another local process to drive
that server without the user's consent (for example CSRF or DNS-rebinding against the
API) are in scope.

This is a solo-maintained project — reports are acknowledged as soon as possible;
please allow reasonable time for a fix before public disclosure.
