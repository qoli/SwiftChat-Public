(async () => {
  try {
    const response = await fetch(new URL('../releases/alpha.json', import.meta.url), {cache: 'no-cache'});
    if (!response.ok) throw new Error('Release metadata unavailable');
    const release = await response.json();
    const url = new URL(release.downloadUrl);
    if (release.schemaVersion !== 1 || release.channel !== 'alpha' || !release.version || !release.build || url.origin !== 'https://github.com' || !url.pathname.startsWith('/qoli/SwiftChat-Public/releases/download/')) throw new Error('Invalid release metadata');
    for (const link of document.querySelectorAll('[data-download]')) {link.href = url.href; link.textContent = 'Download for macOS';}
    for (const label of document.querySelectorAll('[data-release-status]')) label.textContent = `${release.version} (${release.build}) · Alpha · macOS ${release.minimumSystemVersion} or later`;
    const changelog = document.querySelector('[data-changelog]');
    if (changelog) {
      changelog.replaceChildren();
      const title = document.createElement('h2'); title.textContent = `${release.version} · Alpha`;
      const notes = document.createElement('pre'); notes.textContent = release.notes;
      const link = document.createElement('a'); link.href = release.releaseUrl; link.textContent = 'View release on GitHub';
      if (!link.href.startsWith('https://github.com/qoli/SwiftChat-Public/releases/')) throw new Error('Invalid release URL');
      changelog.append(title, notes, link);
    }
  } catch { /* The static page states release availability accurately until a verified release exists. */ }
})();
