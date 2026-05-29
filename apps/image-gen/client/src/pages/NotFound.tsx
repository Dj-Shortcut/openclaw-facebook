import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  const handleGoHome = () => {
    setLocation("/");
  };

  return (
    <div className="flex min-h-full w-full items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4 py-12">
      <Card className="mx-4 w-full max-w-lg border border-slate-800 bg-slate-900/85 shadow-lg shadow-slate-950/30 backdrop-blur-sm">
        <CardContent className="pt-8 pb-8 text-center">
          <div className="flex justify-center mb-6">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-red-500/15 animate-pulse" />
              <AlertCircle className="relative h-16 w-16 text-red-400" />
            </div>
          </div>

          <h1 className="mb-2 text-4xl font-bold text-slate-50">404</h1>

          <h2 className="mb-4 text-xl font-semibold text-slate-200">
            Page Not Found
          </h2>

          <p className="mb-8 leading-relaxed text-slate-300">
            Sorry, the page you are looking for doesn't exist.
            <br />
            It may have been moved or deleted.
          </p>

          <div
            id="not-found-button-group"
            className="flex flex-col sm:flex-row gap-3 justify-center"
          >
            <Button
              onClick={handleGoHome}
              className="rounded-lg bg-cyan-500 px-6 py-2.5 text-slate-950 transition-all duration-200 shadow-md hover:bg-cyan-400 hover:shadow-lg"
            >
              <Home className="w-4 h-4 mr-2" />
              Go Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
