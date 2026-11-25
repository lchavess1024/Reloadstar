# Releasing Reloadstar

Ordinary pushes to main run CI. When the manifest and package versions match, push a version tag such as **v1.0.1** from main. The Release workflow verifies the tag, runs tests, and attaches a ZIP and SHA-256 checksum to the GitHub release. A separate publish job verifies the checksum and checks that any existing release contains the same files. When Store publishing is enabled, it also uploads the ZIP and submits it to the existing Reloadstar listing. Google reviews submissions and distributes approved updates through Chrome.

## First Chrome Web Store release

1. Upload the ZIP from **npm run package** as a new item in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). An extension ZIP is the only artifact to upload there.
2. Complete the listing, privacy declarations, publishing visibility, and review submission in the dashboard. Use [the Reloadstar privacy policy](https://github.com/lchavess1024/Reloadstar/blob/main/PRIVACY.md) and provide a screenshot that shows the extension in Chrome.
3. Wait for the first version to publish. The API can submit updates for the existing listing after that.

## Enable Store updates

Use GitHub-to-Google Workload Identity Federation with an approved Chrome Web Store service account. Obtain authorization for the publisher in the Developer Dashboard and constrain Google trust to this GitHub repository and the release workflow. Scope the condition to the immutable repository and owner IDs. Restrict the workflow reference to main or a version tag. A service account authorized on an existing publisher can have access to its other items, so verify that this scope is intended before using that account for Reloadstar.

Set these variables in **GitHub → Settings → Secrets and variables → Actions**.

| Variable | Value |
| --- | --- |
| CWS_PUBLISHER_ID | Publisher ID from Developer Dashboard |
| CWS_ITEM_ID | Reloadstar's 32-character Store item ID |
| CWS_WIF_PROVIDER | Full Google Workload Identity Provider resource name |
| CWS_SERVICE_ACCOUNT | Approved service account email |
| CWS_PUBLISH_ENABLED | true after authentication has been verified |

Dispatch **Release** manually on main to verify authorization before setting CWS_PUBLISH_ENABLED. That run reads the production Reloadstar listing with a read-only token. A later version tag on main submits the exact ZIP from its GitHub release when Store publishing is enabled. If federation is unavailable, download the GitHub release ZIP and checksum, verify the checksum, and upload that ZIP from the dashboard. Coordinate dashboard uploads with the workflow, since Chrome Web Store does not expose an individual identifier for an asynchronous upload. See the [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api/) and [Google GitHub Actions authentication](https://github.com/google-github-actions/auth).
