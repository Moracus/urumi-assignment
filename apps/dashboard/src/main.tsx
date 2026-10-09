import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <main>
      <h1>Urumi MCP Gateway</h1>
      <p>
        Dashboard scaffold — server management, team, audit and chat are next.
      </p>
      <p>
        Backend: <code>http://localhost:3000/health/live</code>
      </p>
    </main>
  </React.StrictMode>,
);
