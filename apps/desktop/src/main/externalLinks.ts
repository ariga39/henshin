const galleryPath = /^\/g\/([0-9]+)\/([a-f0-9]+)\/?$/i;

export function externalGalleryUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (!['e-hentai.org', 'g.e-hentai.org', 'exhentai.org'].includes(host)) return null;
    const match = url.pathname.match(galleryPath);
    if (!match) return null;
    const gid = BigInt(match[1]);
    if (gid === 0n || gid > 18_446_744_073_709_551_615n) return null;
    const canonicalHost = host === 'g.e-hentai.org' ? 'e-hentai.org' : host;
    return `https://${canonicalHost}/g/${gid}/${match[2].toLowerCase()}/`;
  } catch {
    return null;
  }
}

type WindowOpenDecision = { action: 'deny' };
type NavigationEvent = { preventDefault(): void };
export type ExternalNavigationContents = {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenDecision): void;
  on(event: 'will-navigate', listener: (event: NavigationEvent, url: string) => void): void;
};

export function installExternalNavigationPolicy(
  contents: ExternalNavigationContents,
  appUrl: string,
  openExternal: (url: string) => unknown,
): void {
  const openGallery = (url: string) => {
    const target = externalGalleryUrl(url);
    if (target) void openExternal(target);
  };
  contents.setWindowOpenHandler(({ url }) => {
    openGallery(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url === appUrl) return;
    event.preventDefault();
    openGallery(url);
  });
}
