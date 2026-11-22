import { Layer, ManagedRuntime } from "effect"
import { PrototypeClient, ReaderProfileClient, RootPreviewClient, ScanReviewClient } from "./client"
import { LibraryClient } from "./client"

/**
 * One renderer runtime, created once outside component render.
 */
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    PrototypeClient.layer,
    ReaderProfileClient.layer,
    RootPreviewClient.layer,
    ScanReviewClient.layer,
    LibraryClient.layer
  )
)
