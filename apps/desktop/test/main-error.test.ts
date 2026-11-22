import { Cause } from "effect"
import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: {
    disableHardwareAcceleration: vi.fn(),
    whenReady: () => ({ then: vi.fn() }),
    on: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn()
  },
  BrowserWindow: vi.fn(),
  dialog: {},
  ipcMain: { handle: vi.fn() }
}))

import { localMappingError } from "../src/main/main"

describe("local mapping request errors", () => {
  it("makes a lifecycle timeout retryable and local-specific", () => {
    expect(localMappingError(new Cause.TimeoutError())).toEqual({
      code: "local_mapping_unavailable",
      message: "the selected local directory could not be inspected",
      retryable: true
    })
  })
})
