import React from "react";
import ReactDOM from "react-dom/client";
import { CopilotKitProvider, CopilotSidebar } from "@copilotkit/react-core/v2";

import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";
import { Dashboard, copilotRuntimeUrl } from "./App";

const chatDisabled = import.meta.env.VITE_COPILOT_DISABLED === "true";

const App = () => (
  <CopilotKitProvider runtimeUrl={copilotRuntimeUrl}>
    {chatDisabled ? null : (
      <CopilotSidebar
        defaultOpen={false}
        labels={{
          modalHeaderTitle: "Investigation copilot",
          welcomeMessageText:
            "Ask about the loaded bundle. Queries go through the panel relay, not this chat.",
        }}
      />
    )}
    <Dashboard />
  </CopilotKitProvider>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
