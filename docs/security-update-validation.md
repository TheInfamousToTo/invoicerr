# Critical dependency update validation

The fix branch updates Better Auth to 1.7.14, Handlebars to 4.7.10,
simple-git to 4.0.2, and the locked proxy-addr dependency to 2.0.8.
Prisma's generator, client, and PostgreSQL adapter are aligned at 7.6.0 to avoid
a missing query-compiler runtime module on startup.
The runtime image now installs Chromium and shared libraries from Debian's
current repositories rather than inheriting the external server image.

## OIDC upgrade

Better Auth 1.7 uses `/api/auth/callback/PROVIDER_ID` instead of
`/api/auth/oauth2/callback/PROVIDER_ID`. Register the new callback URL with
the identity provider before deployment. The provider ID remains `OIDC_NAME`.
PKCE is enabled by default; the provider must support it.

Set `OIDC_DISCOVERY_URL` to the provider's OpenID configuration document,
or set `OIDC_ISSUER` to derive its `/.well-known/openid-configuration` URL.
A JWKS document is not a discovery document. Discovery must include the issuer
and signing keys used to verify identity tokens.

## Verification before a PR

1. Run `npm ci` in backend and frontend, generate Prisma, and build both apps.
2. Run `npm test -- --runInBand` in backend.
3. Run `node --test scripts/security-regression.test.cjs` from the repository root.
4. Build the image with fresh base images and package metadata:
   `docker build --pull --no-cache -t invoicerr:critical-fixes .`
5. Run the image checks from the repository root:
   `docker run --rm --entrypoint node -v "${PWD}/scripts:/checks:ro" invoicerr:critical-fixes /checks/container-smoke.cjs`
6. Save a complete scan:
   `trivy image --format json --output trivy-critical-fixes.json invoicerr:critical-fixes`
   Then enforce the available-fix critical gate:
   `trivy image --severity CRITICAL --ignore-unfixed --exit-code 1 invoicerr:critical-fixes`
   Review and report remaining unfixed findings separately; passing this gate
   does not mean the image has zero vulnerabilities.
7. Deploy to a disposable test database and SMTP service. Run all thirteen Cypress
   specs in `e2e/cypress/e2e`, plus an OIDC login/logout and existing-account
   sign-in check. Verify invoice/quote/receipt PDFs and email attachments.
   The Cypress reset task resets its configured database; use a dedicated test
   database with no production data.

On a Linux Docker host, the disposable stack can be run from the repository root:

```sh
docker compose -p invoicerr-security -f scripts/compose.security-test.yml up -d --build
docker compose -p invoicerr-security -f scripts/compose.security-test.yml --profile tests run --rm e2e
```

The test image enables Cypress selectors using `VITE_E2E_TESTING=true` at build
time. Production builds default to disabling those selectors. The test services
bind only to localhost and use ports 5433, 6284, and 8025. Wait for the app at
`http://localhost:6284` before starting Cypress. This stack is independent of the
production database and email credentials.

The original scan report is in the adjacent infrastructure repository at
`../talos-satrawi/docs/invoicerr-vulnerabilities-2026-10-29.md`.

## Remaining Debian findings

The first rebuilt Bookworm image scan reported four critical findings without
available fixes in Bookworm. They are not suppressed:

| Package | CVE | Debian status |
| --- | --- | --- |
| GLib | [CVE-2026-58016](https://security-tracker.debian.org/tracker/CVE-2026-58016) | Bookworm fix postponed; newer Debian release fixed |
| SQLite | [CVE-2025-7458](https://security-tracker.debian.org/tracker/CVE-2025-7458) | Bookworm no DSA; newer Debian release fixed |
| libxml2 | [CVE-2026-6653](https://security-tracker.debian.org/tracker/CVE-2026-6653) | Bookworm fix postponed; also unresolved in Trixie |
| zlib | [CVE-2023-45853](https://security-tracker.debian.org/tracker/CVE-2023-45853) | Debian ignores this in Bookworm because affected contrib/minizip code is not built |

These scanner results do not establish application reachability. Moving to a
newer Debian release would still leave the libxml2 finding and requires separate
compatibility validation. Re-scan the final image after every dependency change.
