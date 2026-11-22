import "./collection.css"
import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import { RootPreviewScreen } from "./RootPreview"
import { App } from "./App"
import { runtime } from "./runtime"
import { loadConnectionStatus, loadRootWorkspace } from "./workflows"

const container = document.getElementById("root")
if (container === null) throw new Error("missing #root container")

const prototype = new URLSearchParams(location.search).get("mode") === "prototype"

const Root = () => {
  useEffect(() => {
    void runtime.runPromise(prototype ? loadConnectionStatus : loadRootWorkspace)
  }, [])
  return prototype ? <App /> : <RootPreviewScreen />
}

createRoot(container).render(<Root />)
