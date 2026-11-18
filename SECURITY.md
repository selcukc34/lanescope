# Security Policy

## Supported versions

Security fixes go into the latest released version. Please update to it before reporting.

## Reporting a vulnerability

Please **do not** open a public issue, discussion or pull request for a security problem.

Report it privately through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/selcukc34/lanescope/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version, and how to reproduce it.

**Do not attach customer `.twx` exports or other confidential files.** If a file is needed to reproduce the problem, build a minimal one that holds no customer data, or describe its structure.

We aim to answer within a week, keep you informed while a fix is prepared, and credit you in the release notes unless you prefer otherwise.

## Scope

Lanescope is a read-only viewer that makes no network requests. Issues of particular interest:

- a way for an opened file to make the extension write, change or delete files;
- script execution or network access from the diagram view (Content Security Policy bypass);
- crafted `.bpmn`, `.zip` or `.twx` files that exhaust memory or CPU despite the size limits;
- script text reaching the diagram view while `lanescope.showScripts` is off.
