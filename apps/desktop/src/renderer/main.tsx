import "./collection.css"
import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import { RootPreviewScreen } from "./RootPreview"
import { App } from "./App"
import { runtime } from "./runtime"
import { loadConnectionStatus } from "./workflows"

const container = document.getElementById("root")
if (container === null) throw new Error("missing #root container")

const Root = () => {
  useEffect(() => {
    void runtime.runPromise(loadConnectionStatus)
  }, [])
  return <App />
}

createRoot(container).render(new URLSearchParams(location.search).get("mode") === "prototype" ? <Root /> : <RootPreviewScreen />)
