import { Layer, ManagedRuntime } from "effect"
import {
  LibraryClient,
  ConnectionClient,
  OpenJournalClient,
  LocalMappingClient,
  PrototypeClient,
  ReaderProfileClient,
  RootPreviewClient,
  ScanReviewClient
} from "./client"

/**
 * One renderer runtime, created once outside component render.
 */
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    PrototypeClient.layer,
    ConnectionClient.layer,
    OpenJournalClient.layer,
    ReaderProfileClient.layer,
    RootPreviewClient.layer,
    LocalMappingClient.layer,
    ScanReviewClient.layer,
    LibraryClient.layer
  )
)
