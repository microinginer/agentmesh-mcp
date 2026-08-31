import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";

import { Providers } from "./app/providers";
import { createAppRouter } from "./app/router";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("AgentMesh web root is missing");
}

createRoot(root).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={createAppRouter()} />
    </Providers>
  </StrictMode>,
);
