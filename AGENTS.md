# SwiftChat public website maintenance

This repository owns the public website in `website/dist/`. Follow
`website/README.md` and `.github/workflows/pages.yml` for website maintenance.
For work involving the App repository or other websites, use the installed
`product-web-maintenance` skill to resolve ownership and data flow.

`website/dist/updates/alpha.xml` and `website/dist/releases/alpha.json` belong to
the App release pipeline. Do not hand-edit them or replace a published archive
as part of website work. Blog content consumes the RonnieCC distribution
contract and preserves its routing and canonical ownership.
