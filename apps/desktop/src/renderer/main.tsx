import "./collection.css"
import { createRoot } from "react-dom/client"
import { RootPreviewScreen } from "./RootPreview"
import { App } from "./App"

const container = document.getElementById("root")
if (container === null) throw new Error("missing #root container")
createRoot(container).render(new URLSearchParams(location.search).get("mode") === "prototype" ? <App /> : <RootPreviewScreen />)
