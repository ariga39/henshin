/** Search values are derived copies; display text and paths stay unchanged. */
export const SEARCH_NORMALIZATION_PROFILE = "nfkc-lower-nfc-v1" as const

export const normalizeSearchText = (value: string): string =>
  value.normalize("NFKC").toLowerCase().normalize("NFC")

export const searchBasename = (relativePath: string): string => {
  const separator = relativePath.lastIndexOf("/")
  return separator < 0 ? relativePath : relativePath.slice(separator + 1)
}
