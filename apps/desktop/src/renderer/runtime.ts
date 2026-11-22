import { Layer, ManagedRuntime } from "effect"
import { LibraryClient, PrototypeClient, RootPreviewClient, ScanReviewClient } from "./client"

/**
 * One renderer runtime, created once outside component render.
 */
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(PrototypeClient.layer, RootPreviewClient.layer, ScanReviewClient.layer, LibraryClient.layer)
)
