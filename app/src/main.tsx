import React from "react";
import ReactDOM from "react-dom/client";
import { Amplify } from "aws-amplify";
import App from "./App";

async function init() {
  if (import.meta.env.VITE_USE_FAKE !== "true") {
    // amplify_outputs.json is produced by the Amplify pipeline; absent locally.
    // The path is constructed at runtime so the bundler cannot statically resolve it
    // and will not fail the build when the file is absent.
    const outputsPath = ["../", "amplify_outputs", ".json"].join("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import(/* @vite-ignore */ outputsPath) as { default: any };
    Amplify.configure(mod.default as Record<string, unknown>);
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><App /></React.StrictMode>
  );
}

init();
