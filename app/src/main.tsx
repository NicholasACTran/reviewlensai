import React from "react";
import ReactDOM from "react-dom/client";
import { Amplify } from "aws-amplify";
import outputs from "../amplify_outputs.json";
import { config } from "./config";
import App from "./App";

// Static import → Vite bundles amplify_outputs.json at build time (the deploy pipeline regenerates
// it before `vite build`). A committed placeholder keeps local/fake builds + CI typecheck working.
// In fake mode we never touch AWS, so skip configure (the bundled outputs may be the placeholder).
if (!config.useFake) {
  Amplify.configure(outputs);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
