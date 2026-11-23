export type CanonicalEhGalleryUrl = {
  readonly source: "EH"
  readonly gid: string
  readonly token: string
  readonly preferredDomain: "e-hentai.org" | "exhentai.org"
  readonly canonicalUrl: string
}

const supportedDomains = new Set(["e-hentai.org", "exhentai.org"])
const galleryPath = /^\/g\/([0-9]{1,20})\/([A-Za-z0-9_-]{1,64})\/$/

/**
 * Parses the explicitly supported gallery URL shape without making a request.
 * Query and fragment text is intentionally discarded from the stored link.
 */
export const parseCanonicalEhGalleryUrl = (input: string): CanonicalEhGalleryUrl | null => {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null
  const preferredDomain = parsed.hostname.toLowerCase()
  if (!supportedDomains.has(preferredDomain)) return null
  const match = galleryPath.exec(parsed.pathname)
  if (match === null) return null
  const gid = match[1]
  const token = match[2]
  if (gid === undefined || token === undefined) return null
  return {
    source: "EH",
    gid,
    token,
    preferredDomain: preferredDomain as "e-hentai.org" | "exhentai.org",
    canonicalUrl: `https://${preferredDomain}/g/${gid}/${token}/`
  }
}
