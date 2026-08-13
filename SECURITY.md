# Security

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Public issues can
expose users before a fix is ready.

Use GitHub's private vulnerability reporting form:

https://github.com/recallnet/thwip/security/advisories/new

Include the affected version or commit, what you observed, the likely impact,
and the smallest safe reproduction you can provide. Do not include secrets,
personal data, or data that belongs to another person.

We will acknowledge receipt within seven calendar days. We may ask for more
information. Investigation and fixes can take longer, so we cannot promise a
resolution date. We will coordinate disclosure with you when a report is
confirmed.

Use a public GitHub issue only when you are sure the report is not about a
security vulnerability and contains no sensitive information.

## Supported versions

Thwip is a small, pre-1.0 project. Security fixes target the current `main`
branch and the latest published CLI release. Older commits, prereleases, and
older CLI releases are not supported. We may ask you to confirm that a problem
still exists on `main` or in the latest release.

## Scope

Reports about Thwip's code, hosted service, GitHub App, published package, or
proof and queue security are in scope. Reports about GitHub, Cloudflare, npm,
or another service should go to that service unless the problem is caused by
Thwip's use of it.
