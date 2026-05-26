import { Sparkles } from "lucide-react";

function Home() {
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4 py-12">
      <div className="max-w-md text-center">
        <div className="mb-6">
          <Sparkles className="mx-auto h-16 w-16 text-cyan-400" />
        </div>
        <h1 className="mb-2 text-4xl font-bold text-slate-50">Leaderbot</h1>
        <p className="mb-8 text-lg text-slate-300">
          Transform your photos with AI styles. Message us to get started!
        </p>
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="mb-4 text-xl font-bold text-slate-100">How to Use</h2>
          <ol className="space-y-2 text-left text-slate-300">
            <li><strong>1.</strong> Send a 'hi' or photo on Messenger</li>
            <li><strong>2.</strong> Pick a style (Disco, Anime, Gold, etc.)</li>
            <li><strong>3.</strong> Get your transformed image</li>
            <li><strong>4.</strong> 3 free images per day!</li>
          </ol>
        </div>
        <p className="mt-6 text-sm text-slate-400">
          Find us on Facebook Messenger and start transforming your photos today.
        </p>
      </div>
    </div>
  );
}

export default Home;
