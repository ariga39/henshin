import "./collection.css"
import { useEffect, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { RootPreviewScreen } from "./RootPreview"
import { App } from "./App"
import { LibraryScreen } from "./Library"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { loadConnectionStatus, loadLibraryWorkspace } from "./workflows"

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
    if (prototype) void runtime.runPromise(loadConnectionStatus)
    else void runtime.runPromise(loadLibraryWorkspace)
  }, [])
  return prototype ? <App /> : state.screen === "library" ? <LibraryScreen /> : <RootPreviewScreen />
}

createRoot(container).render(<Root />)
