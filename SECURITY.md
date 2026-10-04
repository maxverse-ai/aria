# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/maxverse-ai/aria/security/advisories/new)
for this repository. Include:

- A description of the issue and the affected component or code path.
- Steps to reproduce, or a proof of concept.
- The impact you believe the issue has.

We will acknowledge the report and follow up in the advisory thread. Please
give us a reasonable window to investigate and ship a fix before any public
disclosure.

## Scope

Aria executes agent commands, runs scheduled tasks, and talks to external
services and channel providers on the user's behalf. Issues that cross trust
boundaries — credential handling, profile or workspace isolation, channel
access control, remote execution surfaces, and update integrity — are
especially in scope.

## Supported versions

Security fixes land on the latest release line. Older release lines receive
fixes at the maintainers' discretion; upgrading to the newest release is the
recommended remediation.
