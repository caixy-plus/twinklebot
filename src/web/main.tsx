import { createRoot } from "react-dom/client";
import { App } from "./components/App.js";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
