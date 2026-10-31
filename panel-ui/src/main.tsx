import React from "react";
import ReactDOM from "react-dom/client";
import { CopilotKitProvider, CopilotSidebar } from "@copilotkit/react-core/v2";

import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";
import { Dashboard, copilotRuntimeUrl } from "./App";
import { I18nProvider, useI18n } from "./i18n";

const chatDisabled = import.meta.env.VITE_COPILOT_DISABLED === "true";

const ChatSidebar = () => {
  const { t } = useI18n();
  if (chatDisabled) return null;
  return (
    <CopilotSidebar
      defaultOpen={false}
      labels={{
        modalHeaderTitle: t("appTitle"),
        welcomeMessageText: t("queryHint"),
      }}
    />
  );
};

const App = () => (
  <CopilotKitProvider runtimeUrl={copilotRuntimeUrl}>
    <I18nProvider>
      <ChatSidebar />
      <Dashboard />
    </I18nProvider>
  </CopilotKitProvider>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
