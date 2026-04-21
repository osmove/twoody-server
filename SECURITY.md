# Security Policy

Twoody Local is in developer preview. We welcome responsible vulnerability reports, but we do not run a paid bug bounty program yet.

## Reporting a Vulnerability

Email `security@twoody.com` with:

- The affected repository and version or commit SHA.
- A short description of the issue and impact.
- Reproduction steps or a proof of concept, if available.
- Whether any secret, token, personal data, or device access was exposed.

We aim to acknowledge reports within 5 business days.

## Scope

In scope:

- Authentication, pairing, token storage, and local-server API issues.
- Device, desktop bridge, MCP, CLI, and browser-agent vulnerabilities.
- Secret leakage in source, releases, containers, or install scripts.

Out of scope:

- Denial-of-service against local development machines.
- Vulnerabilities requiring already-compromised host access.
- Reports against third-party services unless Twoody code creates the exposure.

Please avoid accessing data that is not yours and stop testing once impact is demonstrated.
