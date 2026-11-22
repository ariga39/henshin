import { access, constants as fsConstants, lstat, realpath, stat } from "node:fs/promises"
import type { BigIntStats, Stats } from "node:fs"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Option, Schema } from "effect"
import { RootRelativePath, type EntryResolution } from "@henshin/contracts"
import type { StoredReaderProfile } from "./persistence/ReaderProfileStore"

export interface AcceptedTargetMapping {
  readonly selectedPath: string
  readonly canonicalPath: string
  /** Exact decimal `${dev}:${ino}` captured when the mapping was admitted. */
  readonly admittedRootIdentity: string | null
}

export class OpenTargetError extends Error {
  readonly code = "open_target_invalid"

  constructor(message: string) {
    super(message)
    this.name = "OpenTargetError"
  }
}

const isWithin = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate)
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
}

const sameNativePath = (left: string, right: string): boolean => {
  const normalize = (value: string): string => resolve(value)
  const normalizedLeft = normalize(left)
  const normalizedRight = normalize(right)
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

const nativeIdentity = (metadata: { readonly dev: number | bigint; readonly ino: number | bigint }): string | null => {
  const device = metadata.dev.toString()
  const inode = metadata.ino.toString()
  return device === "0" || inode === "0" ? null : `${device}:${inode}`
}

const isNativeIdentityToken = (value: string): boolean => /^[1-9][0-9]*:[1-9][0-9]*$/u.test(value)

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

const isMissingError = (error: unknown): boolean => {
  const code = errorCode(error)
  return code === "ENOENT" || code === "ENOTDIR"
}

const throwFilesystemError = (
  error: unknown,
  missingMessage: string,
  unavailableMessage: string
): never => {
  throw new OpenTargetError(isMissingError(error) ? missingMessage : unavailableMessage)
}

const readRealpath = async (
  target: string,
  missingMessage: string,
  unavailableMessage: string
): Promise<string> => {
  try {
    return await realpath(target)
  } catch (error) {
    return throwFilesystemError(error, missingMessage, unavailableMessage)
  }
}

const readLstat = async (
  target: string,
  missingMessage: string,
  unavailableMessage: string
): Promise<Stats> => {
  try {
    return await lstat(target) as Stats
  } catch (error) {
    return throwFilesystemError(error, missingMessage, unavailableMessage)
  }
}

const readBigintStat = async (
  target: string,
  missingMessage: string,
  unavailableMessage: string
): Promise<BigIntStats> => {
  try {
    return await stat(target, { bigint: true }) as BigIntStats
  } catch (error) {
    return throwFilesystemError(error, missingMessage, unavailableMessage)
  }
}

const readSiblingEvidence = async (
  target: string
): Promise<{ readonly realPath: string; readonly identity: string } | null> => {
  let realPath: string
  try {
    realPath = await realpath(target)
  } catch (error) {
    if (isMissingError(error)) return null
    return throwFilesystemError(
      error,
      "sibling identity evidence is unavailable on this device; refresh before opening",
      "sibling identity evidence is unavailable on this device; refresh before opening"
    )
  }

  let metadata: BigIntStats
  try {
    metadata = await stat(target, { bigint: true }) as BigIntStats
  } catch (error) {
    if (isMissingError(error)) return null
    return throwFilesystemError(
      error,
      "sibling identity evidence is unavailable on this device; refresh before opening",
      "sibling identity evidence is unavailable on this device; refresh before opening"
    )
  }
  const identity = nativeIdentity(metadata)
  if (identity === null) {
    throw new OpenTargetError("sibling identity evidence is unavailable; refresh before opening")
  }
  return { realPath, identity }
}

const validateNativeComponent = (component: string): void => {
  if (process.platform !== "win32") return
  if (
    component.length === 0 ||
    component.endsWith(" ") ||
    component.endsWith(".") ||
    /[<>:"|?*\u0000-\u001f]/u.test(component) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu.test(component)
  ) {
    throw new OpenTargetError("the accepted location contains a native-invalid Windows name")
  }
}

const safeSegments = (value: string): ReadonlyArray<string> => {
  const decoded = Schema.decodeUnknownOption(RootRelativePath)(value)
  if (Option.isNone(decoded)) throw new OpenTargetError("the accepted entry location is not a safe relative path")
  const segments = value.split("/")
  for (const segment of segments) validateNativeComponent(segment)
  return segments
}

const rejectLinksAlongPath = async (root: string, target: string): Promise<void> => {
  const rootMetadata = await readLstat(
    root,
    "the configured local mapping root is unavailable on this device",
    "the configured local mapping root is unavailable on this device; verify the mount or permissions"
  )
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new OpenTargetError("the configured local mapping root is unavailable")
  }
  const suffix = relative(root, target)
  let current = root
  for (const segment of suffix.length === 0 ? [] : suffix.split(sep)) {
    current = join(current, segment)
    const metadata = await readLstat(
      current,
      "the accepted target is missing on this device",
      "the accepted target is unavailable on this device; verify the mount or permissions"
    )
    if (metadata.isSymbolicLink()) throw new OpenTargetError("the accepted target contains a symbolic link")
  }
}

const ensureCanonicalContainment = async (root: string, target: string): Promise<void> => {
  const canonicalTarget = await readRealpath(
    target,
    "the accepted target is missing on this device",
    "the accepted target is unavailable on this device; verify the mount or permissions"
  )
  if (!isWithin(root, canonicalTarget)) {
    throw new OpenTargetError("the accepted target escaped the configured mapping")
  }
}

const resolveConfiguredRoot = async (mapping: AcceptedTargetMapping): Promise<string> => {
  if (mapping.admittedRootIdentity === null || !isNativeIdentityToken(mapping.admittedRootIdentity)) {
    throw new OpenTargetError("the configured local mapping root identity is unavailable; verify the mapping before opening")
  }
  const selected = await readRealpath(
    mapping.selectedPath,
    "the configured local mapping root is unavailable on this device",
    "the configured local mapping root is unavailable on this device; verify the mount or permissions"
  )
  if (!sameNativePath(selected, mapping.canonicalPath)) {
    throw new OpenTargetError("the configured local mapping root changed")
  }
  let metadata
  try {
    metadata = await lstat(mapping.canonicalPath, { bigint: true }) as BigIntStats
  } catch (error) {
    return throwFilesystemError(
      error,
      "the configured local mapping root is unavailable on this device",
      "the configured local mapping root is unavailable on this device; verify the mount or permissions"
    )
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new OpenTargetError("the configured local mapping root changed")
  }
  const currentIdentity = nativeIdentity(metadata)
  if (currentIdentity === null) {
    throw new OpenTargetError("the configured local mapping root identity is unavailable; verify the mapping before opening")
  }
  if (currentIdentity !== mapping.admittedRootIdentity) {
    throw new OpenTargetError("the configured local mapping root changed")
  }
  return mapping.canonicalPath
}

const ensureSiblingClaimsAreUnambiguous = async (
  root: string,
  resolution: EntryResolution
): Promise<void> => {
  if (resolution.sibling_claims_truncated || resolution.sibling_claims_next_cursor !== null) {
    throw new OpenTargetError("sibling identity evidence is incomplete; refresh before opening")
  }
  const targetSegments = safeSegments(resolution.relative_path)
  const target = resolve(root, ...targetSegments)
  const targetRealPath = await readRealpath(
    target,
    "the accepted target is missing on this device",
    "the accepted target is unavailable on this device; verify the mount or permissions"
  )
  const targetStats = await readBigintStat(
    target,
    "the accepted target is missing on this device",
    "the accepted target is unavailable on this device; verify the mount or permissions"
  )
  const targetIdentity = nativeIdentity(targetStats)
  if (targetIdentity === null) {
    throw new OpenTargetError("the accepted target identity is unavailable; verify the mapping before opening")
  }
  for (const sibling of resolution.sibling_claims) {
    const siblingSegments = safeSegments(sibling.relative_path)
    const siblingPath = resolve(root, ...siblingSegments)
    // The server's sibling set uses its NFC/case-folded parent key. Resolve every
    // candidate here and let the device's native path and file identities decide.
    const siblingEvidence = await readSiblingEvidence(siblingPath)
    if (siblingEvidence === null) continue
    if (
      sameNativePath(targetRealPath, siblingEvidence.realPath) ||
      targetIdentity === siblingEvidence.identity
    ) {
      throw new OpenTargetError("the accepted target is ambiguous with another entry on this device")
    }
  }
}

export const resolveAcceptedTarget = async (
  mapping: AcceptedTargetMapping,
  resolution: EntryResolution,
  profile: StoredReaderProfile
): Promise<string> => {
  if (resolution.status !== "usable" || resolution.reason !== null) {
    throw new OpenTargetError("the accepted entry needs reconciliation before it can be opened")
  }
  if (!profile.supported_formats.includes(resolution.kind)) {
    throw new OpenTargetError("the selected reader profile does not support this entry format")
  }
  if (resolution.kind === "archive" && profile.target_mode !== "archive") {
    throw new OpenTargetError("the selected reader profile requires an image directory")
  }
  if (resolution.kind === "image-directory" && profile.target_mode === "archive") {
    throw new OpenTargetError("the selected reader profile requires an archive")
  }
  if (profile.launch_mode === "explicit-executable" && profile.executablePath === null) {
    throw new OpenTargetError("the selected reader profile has no executable")
  }
  if (resolution.kind === "archive" && profile.target_mode === "first-image") {
    throw new OpenTargetError("first-image mode cannot open an archive")
  }
  const entrySegments = safeSegments(resolution.relative_path)
  const firstPage = profile.target_mode === "first-image" ? resolution.first_page : null
  if (
    profile.target_mode === "first-image" &&
    (firstPage === null || firstPage.name.includes("/") || firstPage.name.includes("\\") || firstPage.name === "." || firstPage.name === ".." || firstPage.name.includes("\u0000"))
  ) {
    throw new OpenTargetError("the accepted first page is unavailable")
  }
  if (firstPage !== null) validateNativeComponent(firstPage.name)
  const root = await resolveConfiguredRoot(mapping)
  const entryTarget = resolve(root, ...entrySegments)
  if (!isWithin(root, entryTarget)) throw new OpenTargetError("the accepted target escaped the configured mapping")
  await rejectLinksAlongPath(root, entryTarget)
  await ensureCanonicalContainment(root, entryTarget)
  const entryMetadata = await readLstat(
    entryTarget,
    "the accepted source is missing on this device",
    "the accepted source is unavailable on this device; verify the mount or permissions"
  )
  if (entryMetadata.isSymbolicLink()) throw new OpenTargetError("the accepted source is unavailable on this device")
  if (resolution.kind === "archive" && !entryMetadata.isFile()) throw new OpenTargetError("the accepted archive target is unavailable")
  if (resolution.kind === "image-directory" && !entryMetadata.isDirectory()) throw new OpenTargetError("the accepted image directory target is unavailable")
  if (Math.trunc(entryMetadata.mtimeMs) !== Math.trunc(resolution.accepted_observation.mtime_ms)) {
    throw new OpenTargetError("the accepted source changed; reconcile the library before opening")
  }
  await ensureSiblingClaimsAreUnambiguous(root, resolution)
  let target = entryTarget
  if (firstPage !== null) {
    target = resolve(target, firstPage.name)
    if (!isWithin(root, target)) throw new OpenTargetError("the accepted first page escaped the configured mapping")
  }
  await rejectLinksAlongPath(root, target)
  await ensureCanonicalContainment(root, target)
  const metadata = await readLstat(
    target,
    "the accepted target is missing on this device",
    "the accepted target is unavailable on this device; verify the mount or permissions"
  )
  if (metadata.isSymbolicLink()) throw new OpenTargetError("the accepted target is a symbolic link")
  if (profile.target_mode === "archive" && (!metadata.isFile() || ![".cbz", ".zip"].includes(extname(target).toLowerCase()))) {
    throw new OpenTargetError("the accepted archive target is unavailable")
  }
  if (profile.target_mode !== "archive" && !metadata.isDirectory() && profile.target_mode === "directory") {
    throw new OpenTargetError("the accepted image directory target is unavailable")
  }
  if (profile.target_mode === "first-image" && !metadata.isFile()) {
    throw new OpenTargetError("the accepted first page is unavailable")
  }
  try {
    await access(target, fsConstants.R_OK)
  } catch (error) {
    const code = errorCode(error)
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new OpenTargetError("the accepted target is missing on this device")
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new OpenTargetError("the accepted target is not readable on this device; check permissions")
    }
    throw new OpenTargetError("the accepted target is unavailable on this device; verify the mount or permissions")
  }
  if (resolution.kind === "archive" && metadata.size !== resolution.accepted_observation.bytes) {
    throw new OpenTargetError("the accepted archive changed; reconcile the library before opening")
  }
  if (profile.target_mode === "first-image" && resolution.first_page !== null && metadata.size !== resolution.first_page.declared_bytes) {
    throw new OpenTargetError("the accepted first page changed; reconcile the library before opening")
  }
  return target
}
