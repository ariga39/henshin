import { Layer, ManagedRuntime } from "effect"
import { PrototypeClient, RootPreviewClient } from "./client"

/**
 * One renderer runtime, created once outside component render.
 */
export const runtime = ManagedRuntime.make(Layer.mergeAll(PrototypeClient.layer, RootPreviewClient.layer))
