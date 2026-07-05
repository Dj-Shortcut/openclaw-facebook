import Footer from "./components/Footer";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";

const Home = lazy(() => import("./pages/Home"));
const NotFound = lazy(() => import("./pages/NotFound"));
const DataDeletionPage = lazy(() =>
  import("./pages/Legal").then(module => ({ default: module.DataDeletionPage }))
);
const PrivacyPage = lazy(() =>
  import("./pages/Legal").then(module => ({ default: module.PrivacyPage }))
);
const TermsPage = lazy(() =>
  import("./pages/Legal").then(module => ({ default: module.TermsPage }))
);

function RouteFallback() {
  return <div className="min-h-full bg-[#f6f2ea]" />;
}

function Router() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Switch>
        <Route path={"/privacy"} component={PrivacyPage} />
        <Route path={"/terms"} component={TermsPage} />
        <Route path={"/data-deletion"} component={DataDeletionPage} />
        <Route path={"/:?"} component={Home} />
        <Route path={"/404"} component={NotFound} />
        {/* Final fallback route */}
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <div className="min-h-screen flex flex-col bg-[#f6f2ea] text-foreground">
            <Toaster />
            <div className="grow bg-[#f6f2ea]">
              <Router />
            </div>
            <Footer />
          </div>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
