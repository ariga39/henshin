import { access, constants as fsConstants, lstat, readFile } from "node:fs/promises"
import { extname, isAbsolute } from "node:path"
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

const MAX_PROFILE_NAME_LENGTH = 128
const MAX_ARGUMENT_TOKENS = 32
const MAX_ARGUMENT_LENGTH = 512
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

  try {
    const header = await readFile(selectedPath, { encoding: "utf8", flag: "r" })
    if (header.startsWith("#!")) {
      throw new ReaderExecutableSelectionError("interpreter and shell wrappers are not supported")
    }
  } catch (error) {
    if (error instanceof ReaderExecutableSelectionError) throw error
    throw new ReaderExecutableSelectionError("the selected executable could not be inspected")
  }
}
