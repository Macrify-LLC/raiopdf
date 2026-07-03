import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RpIconSprite } from "./icons/RpIcon";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("RaioPDF root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <RpIconSprite />
    <App />
  </StrictMode>,
);
