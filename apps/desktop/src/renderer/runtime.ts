import { ManagedRuntime } from "effect"
import { PrototypeClient } from "./client"

/**
 * One renderer runtime, created once outside component render.
 */
export const runtime = ManagedRuntime.make(PrototypeClient.layer)
