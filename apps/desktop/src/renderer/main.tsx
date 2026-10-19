import { useEffect } from "react"
import { createRoot } from "react-dom/client"
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

createRoot(container).render(<Root />)
