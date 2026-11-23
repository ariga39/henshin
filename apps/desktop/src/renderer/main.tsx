import "./collection.css"
import { useEffect, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { RootPreviewScreen } from "./RootPreview"
import { App } from "./App"
import { LibraryScreen } from "./Library"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { handleConnectionStatusChanged, handleConnectionTargetChanged, loadConnectionStatus, loadConnectionWorkspace } from "./workflows"

const container = document.getElementById("root")
if (container === null) throw new Error("missing #root container")

const prototype = new URLSearchParams(location.search).get("mode") === "prototype"
if (!prototype && new URLSearchParams(location.search).get("screen") === "library") {
  viewStore.set({ screen: "library" })
}

const Root = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  useEffect(() => {
    void runtime.runPromise(prototype ? loadConnectionStatus : loadConnectionWorkspace)
  }, [])
  useEffect(() => {
    if (prototype) return
    return window.henshinConnection.onStatusChanged((status) => {
      void runtime.runPromise(handleConnectionStatusChanged(status))
    })
  }, [])
  useEffect(() => {
    if (prototype) return
    return window.henshinConnection.onChanged((target) => {
      void runtime.runPromise(handleConnectionTargetChanged(target))
    })
  }, [])
  return prototype ? <App /> : state.screen === "library" ? <LibraryScreen /> : <RootPreviewScreen />
}

createRoot(container).render(<Root />)
