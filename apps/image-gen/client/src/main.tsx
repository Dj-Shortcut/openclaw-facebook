import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const getOptionalEnvString = (value: unknown): string | undefined => {
  return typeof value === "string" ? value.trim() : undefined;
};

const injectAnalytics = () => {
  if (typeof document === "undefined") return;

  const analyticsEndpoint = getOptionalEnvString(
    import.meta.env.VITE_ANALYTICS_ENDPOINT
  );
  const analyticsWebsiteId = getOptionalEnvString(
    import.meta.env.VITE_ANALYTICS_WEBSITE_ID
  );

  if (!analyticsEndpoint) return;

  const analyticsScript = document.createElement("script");
  analyticsScript.defer = true;
  analyticsScript.src = `${analyticsEndpoint.replace(/\/$/, "")}/umami`;

  if (analyticsWebsiteId) {
    analyticsScript.dataset.websiteId = analyticsWebsiteId;
  }

  document.head.appendChild(analyticsScript);
};

function bootstrap() {
  injectAnalytics();

  createRoot(document.getElementById("root")!).render(<App />);
}

bootstrap();
