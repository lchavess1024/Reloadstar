# Reloadstar

Reloadstar is a small Chrome extension that refreshes the webpages you choose. It shares Clipstar's navy, cyan, and gold-star design.

Right-click a webpage and choose **Reloadstar · Start / stop auto-refresh**. In the toolbar popup you can see the current tab's status, start or stop it, and set an interval between 1 and 86,400 seconds. The default is 30 seconds. Chrome may delay intervals, especially below 30 seconds. A tab that's still loading skips that refresh so slow pages have time to finish.

In Settings, **Keep awake while refreshing** requests that Chrome prevent idle sleep while at least one session is active. System lock and login policies continue to apply.

## Development

Requires Node.js 22 and the standard zip and unzip tools. Run **npm run verify** for the service worker tests and **npm run package** for a Store-ready archive. In Chrome's Extensions page, use **Load unpacked** and select the extension directory for local testing.

[Privacy policy](PRIVACY.md) · [Releasing to Chrome Web Store](docs/RELEASE.md) · [Clipstar](https://github.com/lchavess1024/Clipstar)
