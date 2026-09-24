# Adapter source maintenance

The private SwiftChat repository is the source authority during this initial
public-copy phase. This repository receives a reviewed, one-way export. Do not
independently patch both copies and assume they remain synchronized.

Maintainers run, from the private repository root:

```sh
python3 scripts/sync-public-adapter.py /path/to/SwiftChat-Public
python3 scripts/sync-public-adapter.py /path/to/SwiftChat-Public --check
```

Then, from the public repository root:

```sh
node --test adapter/tests/*.test.cjs
```

The exporter contains an explicit allowlist for the single JavaScript source and
eight synthetic fixture files. New files require a deliberate allowlist edit and
privacy review. It does not export native source, Git history, credentials,
website sessions, live capture artifacts or private design documents. The only
fixture transformation replaces its private repository path with a path relative
to the public fixture, so tests can also run outside the repository working
folder. The script does not commit, push or publish.

`adapter/source-manifest.json` records the source Git revision, whether any
allowlisted source file differs from that revision, the implementation and alpha
protocol versions, and SHA-256 hashes of both original and exported files. A
private revision is provenance, not a publicly accessible source link. Unrelated
private working-tree edits are not copied and do not mark adapter sources dirty.
The hash manifest is not a replacement for signed application updates.

Before publishing: review every changed export for private data, run the fixtures,
review the public diff, and pair the snapshot with its intended native host
version. Public contribution proposals are first reviewed and integrated into the
private source authority, then re-exported. A later transition to public source
authority must explicitly change this policy and pin the app to a verified public
revision; it must not silently introduce runtime JavaScript downloads.
