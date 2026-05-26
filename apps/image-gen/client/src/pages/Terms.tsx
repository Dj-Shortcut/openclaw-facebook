function Terms() {
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4 py-12">
      <div className="max-w-2xl rounded-lg border border-slate-800 bg-slate-900/80 p-8 shadow-lg shadow-slate-950/30">
        <h1 className="mb-4 text-3xl font-bold text-slate-50">Terms of Service</h1>
        <p className="leading-relaxed text-slate-300">
          By using Leaderbot, you agree that uploaded images are processed to generate stylized
          versions. Images are not permanently stored. The service is provided as-is without
          warranty.
        </p>
      </div>
    </div>
  );
}

export default Terms;
