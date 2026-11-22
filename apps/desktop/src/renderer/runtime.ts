import { Layer, ManagedRuntime } from "effect"
import { LibraryClient, LocalMappingClient, PrototypeClient, RootPreviewClient, ScanReviewClient } from "./client"
import { ReaderProfileClient } from "./client"

/**
 * One renderer runtime, created once outside component render.
 */
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    PrototypeClient.layer,
    ReaderProfileClient.layer,
    RootPreviewClient.layer,
    LocalMappingClient.layer,
    ScanReviewClient.layer,
    LibraryClient.layer
  )
)
