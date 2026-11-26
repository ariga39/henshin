import assert from 'node:assert/strict';
import test from 'node:test';
import { externalGalleryUrl, installExternalNavigationPolicy, type ExternalNavigationContents } from './externalLinks.js';

test('only canonical E-Hentai and ExHentai gallery URLs are external targets', () => {
  assert.equal(externalGalleryUrl('http://g.e-hentai.org/g/000618395/0439FA3666/?from=search'), 'https://e-hentai.org/g/618395/0439fa3666/');
  assert.equal(externalGalleryUrl('https://exhentai.org/g/42/abcdef/'), 'https://exhentai.org/g/42/abcdef/');
  for (const url of [
    'https://example.com/g/1/abc/',
    'https://e-hentai.org.evil.test/g/1/abc/',
    'https://e-hentai.org/g/1/abc/extra',
    'https://e-hentai.org/g/0/abc/',
    'https://user@e-hentai.org/g/1/abc/',
    'https://e-hentai.org:8443/g/1/abc/',
    'javascript:alert(1)',
  ]) assert.equal(externalGalleryUrl(url), null, url);
  assert.equal(externalGalleryUrl('https://e-hentai.org:443/g/1/abc/'), 'https://e-hentai.org/g/1/abc/');
});

test('denies child windows and external in-app navigation while opening only gallery targets externally', () => {
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
  let navigationHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
  const opened: string[] = [];
  const contents: ExternalNavigationContents = {
    setWindowOpenHandler: handler => { openHandler = handler; },
    on: (_event, listener) => { navigationHandler = listener; },
  };
  installExternalNavigationPolicy(contents, 'file:///app/index.html', url => opened.push(url));
  assert.deepEqual(openHandler?.({ url: 'https://e-hentai.org/g/0007/ABCDEF/' }), { action: 'deny' });
  assert.deepEqual(openHandler?.({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://e-hentai.org/g/7/abcdef/']);

  let prevented = false;
  navigationHandler?.({ preventDefault: () => { prevented = true; } }, 'file:///app/index.html');
  assert.equal(prevented, false);
  navigationHandler?.({ preventDefault: () => { prevented = true; } }, 'https://example.com/');
  assert.equal(prevented, true);
  navigationHandler?.({ preventDefault: () => { prevented = true; } }, 'https://exhentai.org/g/8/abcdef/');
  assert.deepEqual(opened, ['https://e-hentai.org/g/7/abcdef/', 'https://exhentai.org/g/8/abcdef/']);
});
