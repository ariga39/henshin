import { access, constants as fsConstants, lstat, open, readdir } from "node:fs/promises"
import { extname, isAbsolute, join } from "node:path"
import type { ReaderProfileSaveIpcRequest } from "@henshin/contracts"

export class ReaderProfileValidationError extends Error {
  readonly code = "reader_profile_invalid"

  constructor(message: string) {
    super(message)
    this.name = "ReaderProfileValidationError"
  }
}

export class ReaderExecutableSelectionRequiredError extends Error {
  readonly code = "reader_executable_selection_required"

  constructor() {
    super("choose an executable through the native picker before saving this profile")
    this.name = "ReaderExecutableSelectionRequiredError"
  }
}

export class ReaderExecutableSelectionError extends Error {
  readonly code = "reader_executable_invalid"

  constructor(message: string) {
    super(message)
    this.name = "ReaderExecutableSelectionError"
  }
}

export class ReaderTestTargetError extends Error {
  readonly code = "reader_test_target_invalid"

  constructor(message: string) {
    super(message)
    this.name = "ReaderTestTargetError"
  }
}

export class ReaderTestTargetSelectionError extends Error {
  readonly code = "reader_test_target_selection_expired"

  constructor() {
    super("choose a test target again before launching the reader")
    this.name = "ReaderTestTargetSelectionError"
  }
}

export class ReaderTestLaunchError extends Error {
  readonly code = "reader_test_launch_failed"

  constructor(message: string) {
    super(message)
    this.name = "ReaderTestLaunchError"
  }
}

const MAX_PROFILE_NAME_LENGTH = 128
const MAX_ARGUMENT_TOKENS = 32
const MAX_ARGUMENT_LENGTH = 512
const EXECUTABLE_HEADER_BYTES = 4096
const SHELL_OR_SCRIPT_EXTENSIONS = new Set([
  ".bat",
  ".bash",
  ".cjs",
  ".cmd",
  ".command",
  ".fish",
  ".js",
  ".mjs",
  ".pl",
  ".ps1",
  ".py",
  ".rb",
  ".sh",
  ".vbs",
  ".wsf",
  ".zsh"
])
const ARCHIVE_EXTENSIONS = new Set([".cbz", ".zip"])
const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"])

const hasBytes = (header: Uint8Array, offset: number, bytes: ReadonlyArray<number>): boolean =>
  offset + bytes.length <= header.length && bytes.every((byte, index) => header[offset + index] === byte)

const isMachOHeader = (header: Uint8Array): boolean =>
  hasBytes(header, 0, [0xfe, 0xed, 0xfa, 0xce]) ||
  hasBytes(header, 0, [0xfe, 0xed, 0xfa, 0xcf]) ||
  hasBytes(header, 0, [0xce, 0xfa, 0xed, 0xfe]) ||
  hasBytes(header, 0, [0xcf, 0xfa, 0xed, 0xfe]) ||
  hasBytes(header, 0, [0xca, 0xfe, 0xba, 0xbe]) ||
  hasBytes(header, 0, [0xca, 0xfe, 0xba, 0xbf]) ||
  hasBytes(header, 0, [0xbe, 0xba, 0xfe, 0xca]) ||
  hasBytes(header, 0, [0xbf, 0xba, 0xfe, 0xca])

const isElfHeader = (header: Uint8Array): boolean => hasBytes(header, 0, [0x7f, 0x45, 0x4c, 0x46])

const isPeHeader = (header: Uint8Array): boolean => {
  if (!hasBytes(header, 0, [0x4d, 0x5a]) || header.length < 0x40) return false
  const peOffset = header[0x3c] | (header[0x3d] << 8) | (header[0x3e] << 16) | (header[0x3f] << 24)
  return peOffset >= 0x40 && hasBytes(header, peOffset, [0x50, 0x45, 0x00, 0x00])
}

const isSupportedNativeExecutable = (header: Uint8Array): boolean => {
  switch (process.platform) {
    case "darwin":
      return isMachOHeader(header)
    case "linux":
      return isElfHeader(header)
    case "win32":
      return isPeHeader(header)
    default:
      return false
  }
}

export const validateReaderProfile = (
  input: Pick<ReaderProfileSaveIpcRequest, "name" | "launch_mode" | "supported_formats" | "target_mode" | "argument_tokens">,
  executablePath: string | null
): void => {
  const name = input.name.trim()
  if (name.length === 0 || name.length > MAX_PROFILE_NAME_LENGTH) {
    throw new ReaderProfileValidationError("profile name must be between 1 and 128 characters")
  }
  if (input.supported_formats.length === 0 || new Set(input.supported_formats).size !== input.supported_formats.length) {
    throw new ReaderProfileValidationError("choose at least one supported entry format without duplicates")
  }

  const supportsArchive = input.supported_formats.includes("archive")
  const supportsDirectory = input.supported_formats.includes("image-directory")
  const targetMatchesFormat = input.target_mode === "archive" ? supportsArchive && !supportsDirectory : supportsDirectory && !supportsArchive
  if (!targetMatchesFormat) {
    throw new ReaderProfileValidationError(
      input.target_mode === "first-image"
        ? "first-image target mode is only compatible with image-directory profiles"
        : `${input.target_mode} target mode is incompatible with the selected entry formats`
    )
  }

  if (input.launch_mode === "system-association") {
    if (executablePath !== null) {
      throw new ReaderProfileValidationError("system association profiles cannot retain an executable")
    }
    if (input.argument_tokens.length !== 0) {
      throw new ReaderProfileValidationError("system association profiles do not accept argument tokens")
    }
    return
  }

  if (executablePath === null) throw new ReaderExecutableSelectionRequiredError()
  if (input.argument_tokens.length > MAX_ARGUMENT_TOKENS) {
    throw new ReaderProfileValidationError("a profile can contain at most 32 argument tokens")
  }
  const targetTokenCount = input.argument_tokens.filter((token) => token === "{target}").length
  if (targetTokenCount !== 1 || input.argument_tokens.some((token) => token !== "{target}" && token.includes("{target}"))) {
    throw new ReaderProfileValidationError("arguments must contain exactly one whole {target} token")
  }
  if (input.argument_tokens.some((token) => token.length === 0 || token.length > MAX_ARGUMENT_LENGTH || token.includes("\u0000"))) {
    throw new ReaderProfileValidationError("argument tokens must be non-empty and at most 512 characters")
  }
}

/** Re-checks the main-owned selection immediately before persistence. */
export const validateExecutablePath = async (selectedPath: string): Promise<void> => {
  if (!isAbsolute(selectedPath) || selectedPath.includes("\u0000")) {
    throw new ReaderExecutableSelectionError("the selected executable is not an absolute native file")
  }
  const extension = extname(selectedPath).toLowerCase()
  if (SHELL_OR_SCRIPT_EXTENSIONS.has(extension)) {
    throw new ReaderExecutableSelectionError("shell scripts and interpreter wrappers are not supported")
  }

  let metadata
  try {
    metadata = await lstat(selectedPath)
  } catch {
    throw new ReaderExecutableSelectionError("the selected executable is unavailable")
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ReaderExecutableSelectionError("choose a regular executable file, not a directory or link")
  }

  if (process.platform === "win32" && extension !== ".exe" && extension !== ".com") {
    throw new ReaderExecutableSelectionError("Windows reader profiles require an .exe or .com executable")
  }
  if (process.platform !== "win32") {
    try {
      await access(selectedPath, fsConstants.X_OK)
    } catch {
      throw new ReaderExecutableSelectionError("the selected file is not executable")
    }
  }

  let header: Buffer
  try {
    const file = await open(selectedPath, "r")
    try {
      header = Buffer.alloc(EXECUTABLE_HEADER_BYTES)
      const { bytesRead } = await file.read(header, 0, header.length, 0)
      header = header.subarray(0, bytesRead)
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof ReaderExecutableSelectionError) throw error
    throw new ReaderExecutableSelectionError("the selected executable could not be inspected")
  }
  if (hasBytes(header, 0, [0x23, 0x21])) {
    throw new ReaderExecutableSelectionError("interpreter and shell wrappers are not supported")
  }
  if (!isSupportedNativeExecutable(header)) {
    throw new ReaderExecutableSelectionError("the selected file is not a supported native executable")
  }
}

const validateSelectedPath = async (selectedPath: string): Promise<Awaited<ReturnType<typeof lstat>>> => {
  if (!isAbsolute(selectedPath) || selectedPath.includes("\u0000")) {
    throw new ReaderTestTargetError("the selected test target is not an absolute path")
  }
  let metadata
  try {
    metadata = await lstat(selectedPath)
  } catch {
    throw new ReaderTestTargetError("the selected test target is unavailable")
  }
  if (metadata.isSymbolicLink()) {
    throw new ReaderTestTargetError("choose a regular test target, not a link")
  }
  try {
    await access(selectedPath, fsConstants.R_OK)
  } catch {
    throw new ReaderTestTargetError("the selected test target is not readable")
  }
  return metadata
}

/** Resolves a native-picker selection to the exact path that a profile test may receive. */
export const resolveReaderTestTarget = async (
  selectedPath: string,
  targetMode: "archive" | "directory" | "first-image"
): Promise<string> => {
  const metadata = await validateSelectedPath(selectedPath)
  if (targetMode === "archive") {
    if (!metadata.isFile() || !ARCHIVE_EXTENSIONS.has(extname(selectedPath).toLowerCase())) {
      throw new ReaderTestTargetError("choose a readable ZIP or CBZ archive")
    }
    return selectedPath
  }

  if (!metadata.isDirectory()) {
    throw new ReaderTestTargetError("choose a readable image directory")
  }
  if (targetMode === "directory") return selectedPath

  let entries
  try {
    entries = await readdir(selectedPath, { withFileTypes: true })
  } catch {
    throw new ReaderTestTargetError("the selected image directory could not be read")
  }
  const firstImage = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)[0]
  if (firstImage === undefined) {
    throw new ReaderTestTargetError("the selected image directory has no supported image")
  }
  const resolved = join(selectedPath, firstImage)
  await validateSelectedPath(resolved)
  return resolved
}
