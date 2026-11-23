import "./collection.css"
import { Effect } from "effect"
import { useEffect, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { RootPreviewScreen } from "./RootPreview"
import { App } from "./App"
import { LibraryScreen } from "./Library"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { loadConnectionStatus, loadLibraryConnectionStatus, loadRootWorkspace } from "./workflows"

const container = document.getElementById("root")
if (container === null) throw new Error("missing #root container")

const prototype = new URLSearchParams(location.search).get("mode") === "prototype"
if (!prototype && new URLSearchParams(location.search).get("screen") === "library") {
  viewStore.set({
    screen: "library",
    connection: { ...viewStore.getState().connection, state: "connecting" }
  })
}

const Root = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  useEffect(() => {
    void runtime.runPromise(prototype
      ? loadConnectionStatus
      : Effect.gen(function*() {
          yield* loadLibraryConnectionStatus
          if (viewStore.getState().connection.state === "connected") yield* loadRootWorkspace
        }))
  }, [])
  return prototype ? <App /> : state.screen === "library" ? <LibraryScreen /> : <RootPreviewScreen />
}

createRoot(container).render(<Root />)
