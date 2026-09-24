# SwiftChat

SwiftChat is a native Mac app for AI conversations, ChatGPT Web, browsing, and
read-only context from other apps. This repository is its public distribution
and collaboration home. Public distribution currently targets **macOS only**.

- Website: [swiftchat.ronniewong.cc](https://swiftchat.ronniewong.cc)
- Downloads and version notes: [GitHub Releases](https://github.com/qoli/SwiftChat-Public/releases)
- Problems and compatibility reports: [Issues](https://github.com/qoli/SwiftChat-Public/issues)
- Release announcements: [RonnieAppsChannel](https://t.me/RonnieAppsChannel)

The SwiftChat application is **closed source**. The ChatGPT Web adapter in
[`adapter/`](adapter/) is separately published under the MIT license. This is
an unofficial integration, not an OpenAI product or an official ChatGPT SDK.
Your ChatGPT account, available features, and website behavior remain controlled
by ChatGPT.

## Open adapter — alpha

The public protocol is **0.1.0-alpha.1**. The bundled implementation retains its
existing adapter version; see [`adapter/source-manifest.json`](adapter/source-manifest.json).
Alpha protocol revisions may contain breaking changes. A published source snapshot
is not a guarantee of compatibility with the current live website.

This is a native WebKit host adapter, not a standalone browser extension or
installable userscript. It depends on a host bridge and the website's mounted
composer. Start with the [host contract](docs/adapter-protocol.md) and
[maintenance policy](docs/adapter-maintenance.md).

Run its synthetic compatibility fixtures with Node.js 20 or later:

```sh
node --test adapter/tests/*.test.cjs
```

No account or credentials are needed for fixtures. Live signed-in WebKit behavior
needs separate verification. Do not include credentials, real conversation text,
attachments, captured application text, or unredacted diagnostics in reports.

## Licensing

Only `adapter/` is licensed under [MIT](adapter/LICENSE). The license does not
cover SwiftChat application binaries, private native source, branding, screenshots,
or other website assets. See the [repository license scope](LICENSE).
