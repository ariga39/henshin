import { access, constants as fsConstants, lstat, realpath } from "node:fs/promises"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Option, Schema } from "effect"
import { RootRelativePath, type EntryResolution } from "@henshin/contracts"
import type { StoredReaderProfile } from "./persistence/ReaderProfileStore"

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

const safeSegments = (value: string): ReadonlyArray<string> => {
  const decoded = Schema.decodeUnknownOption(RootRelativePath)(value)
  if (Option.isNone(decoded)) throw new OpenTargetError("the accepted entry location is not a safe relative path")
  return value.split("/")
}

const rejectLinksAlongPath = async (root: string, target: string): Promise<void> => {
  const rootMetadata = await lstat(root).catch(() => null)
  if (rootMetadata === null || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new OpenTargetError("the configured local mapping root is unavailable")
  }
  const suffix = relative(root, target)
  let current = root
  for (const segment of suffix.length === 0 ? [] : suffix.split(sep)) {
    current = join(current, segment)
    const metadata = await lstat(current).catch(() => null)
    if (metadata === null) throw new OpenTargetError("the accepted target is missing on this device")
    if (metadata.isSymbolicLink()) throw new OpenTargetError("the accepted target contains a symbolic link")
  }
}

export const resolveAcceptedTarget = async (
  mappingRoot: string,
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
  const root = await realpath(mappingRoot).catch(() => null)
  if (root === null || !isWithin(mappingRoot, root)) {
    throw new OpenTargetError("the configured local mapping root changed")
  }
  const entrySegments = safeSegments(resolution.relative_path)
  const entryTarget = resolve(root, ...entrySegments)
  if (!isWithin(root, entryTarget)) throw new OpenTargetError("the accepted target escaped the configured mapping")
  const entryMetadata = await lstat(entryTarget).catch(() => null)
  if (entryMetadata === null || entryMetadata.isSymbolicLink()) throw new OpenTargetError("the accepted source is unavailable on this device")
  if (resolution.kind === "archive" && !entryMetadata.isFile()) throw new OpenTargetError("the accepted archive target is unavailable")
  if (resolution.kind === "image-directory" && !entryMetadata.isDirectory()) throw new OpenTargetError("the accepted image directory target is unavailable")
  if (Math.trunc(entryMetadata.mtimeMs) !== Math.trunc(resolution.accepted_observation.mtime_ms)) {
    throw new OpenTargetError("the accepted source changed; reconcile the library before opening")
  }
  let target = entryTarget
  if (profile.target_mode === "first-image") {
    const firstPage = resolution.first_page
    if (firstPage === null || firstPage.name.includes("/") || firstPage.name.includes("\\") || firstPage.name === "." || firstPage.name === ".." || firstPage.name.includes("\u0000")) {
      throw new OpenTargetError("the accepted first page is unavailable")
    }
    target = resolve(target, firstPage.name)
    if (!isWithin(root, target)) throw new OpenTargetError("the accepted first page escaped the configured mapping")
  }
  await rejectLinksAlongPath(root, target)
  const metadata = await lstat(target).catch(() => null)
  if (metadata === null) throw new OpenTargetError("the accepted target is missing on this device")
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
  } catch {
    throw new OpenTargetError("the accepted target is not readable on this device")
  }
  if (resolution.kind === "archive" && metadata.size !== resolution.accepted_observation.bytes) {
    throw new OpenTargetError("the accepted archive changed; reconcile the library before opening")
  }
  return target
}
