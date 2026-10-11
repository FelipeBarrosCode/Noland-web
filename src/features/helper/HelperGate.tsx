import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { getHelperAvailability } from "../../helper/client";
import { translate } from "../../lib/i18n";
import { isRunningInTauri } from "../../lib/tauri";
import { HELPER_RELEASE_PAGE, resolveHelperDownload } from "../../helper/releases";

export function HelperGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"checking" | "missing" | "ready">(
    isRunningInTauri() ? "ready" : "checking",
  );
  const [downloadUrl, setDownloadUrl] = useState(HELPER_RELEASE_PAGE);

  useEffect(() => {
    if (isRunningInTauri()) return;
    let cancelled = false;
    let timer: number | null = null;
    const check = async () => {
      const availability = await getHelperAvailability(true);
      if (cancelled) return;
      setStatus(availability === "ready" ? "ready" : availability === "starting" ? "checking" : "missing");
      if (availability !== "ready") timer = window.setTimeout(() => void check(), 2_000);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!isRunningInTauri()) void resolveHelperDownload().then(setDownloadUrl);
  }, []);

  if (status === "ready") return children;

  return (
    <main className="crt-surface flex min-h-dvh items-center justify-center bg-hero-glow p-5">
      <Card className="pixel-frame w-full max-w-2xl border-neon-cyan p-6">
        <p className="font-display text-xs uppercase tracking-[0.18em] text-neon-cyan">
          {translate("web.helper.eyebrow")}
        </p>
        <h1 className="mt-3 font-display text-xl text-white">
          {status === "checking"
            ? translate("web.helper.checking")
            : translate("web.helper.required")}
        </h1>
        <p className="mt-4 text-[1.2rem] leading-snug text-[#cfe7ff]">
          {translate("web.helper.description")}
        </p>
        {status === "missing" ? (
          <div className="mt-5 flex flex-wrap gap-3">
            <a href={downloadUrl} target="_blank" rel="noreferrer">
              <Button>{translate("web.helper.install")}</Button>
            </a>
            <Button variant="ghost" onClick={() => setStatus("checking")}>
              {translate("web.helper.retry")}
            </Button>
          </div>
        ) : null}
        <p className="mt-5 text-sm text-[#91a9c3]">{translate("web.helper.handoff")}</p>
      </Card>
    </main>
  );
}
