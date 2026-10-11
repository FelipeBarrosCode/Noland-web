import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { getHelperAvailability, getLoopbackPermission } from "../../helper/client";
import { translate } from "../../lib/i18n";
import { isRunningInTauri } from "../../lib/tauri";
import { HELPER_RELEASE_PAGE, resolveHelperDownload } from "../../helper/releases";

export function HelperGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"checking" | "missing" | "permission" | "blocked" | "ready">(
    isRunningInTauri() ? "ready" : "checking",
  );
  const [downloadUrl, setDownloadUrl] = useState(HELPER_RELEASE_PAGE);

  useEffect(() => {
    if (isRunningInTauri()) return;
    let cancelled = false;
    let timer: number | null = null;
    const check = async (userInitiated = false) => {
      // Begin the fetch before any await so a button click remains a browser user gesture
      // capable of opening Chrome's loopback-network permission prompt.
      const availability = await getHelperAvailability(true);
      if (cancelled) return;
      if (availability === "ready") {
        setStatus("ready");
        return;
      }
      const permission = await getLoopbackPermission();
      if (cancelled) return;
      if (permission === "denied") {
        setStatus("blocked");
        return;
      }
      if (permission === "prompt") {
        setStatus("permission");
        return;
      }
      setStatus(availability === "starting" ? "checking" : "missing");
      if (!userInitiated) timer = window.setTimeout(() => void check(), 2_000);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  const retry = () => {
    setStatus("checking");
    void getHelperAvailability(true).then(async (availability) => {
      if (availability === "ready") {
        setStatus("ready");
        return;
      }
      const permission = await getLoopbackPermission();
      setStatus(permission === "denied" ? "blocked" : permission === "prompt" ? "permission" : "missing");
    });
  };

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
            : status === "permission"
              ? translate("web.helper.permissionTitle")
              : status === "blocked"
                ? translate("web.helper.blockedTitle")
                : translate("web.helper.required")}
        </h1>
        <p className="mt-4 text-[1.2rem] leading-snug text-[#cfe7ff]">
          {status === "permission"
            ? translate("web.helper.permissionDescription")
            : status === "blocked"
              ? translate("web.helper.blockedDescription")
              : translate("web.helper.description")}
        </p>
        {status === "missing" ? (
          <div className="mt-5 flex flex-wrap gap-3">
            <a href={downloadUrl} target="_blank" rel="noreferrer">
              <Button>{translate("web.helper.install")}</Button>
            </a>
            <Button variant="ghost" onClick={retry}>
              {translate("web.helper.retry")}
            </Button>
          </div>
        ) : null}
        {status === "permission" ? (
          <div className="mt-5">
            <Button onClick={retry}>{translate("web.helper.allowAccess")}</Button>
          </div>
        ) : null}
        {status === "blocked" ? (
          <div className="mt-5">
            <Button variant="ghost" onClick={retry}>{translate("web.helper.retry")}</Button>
          </div>
        ) : null}
        <p className="mt-5 text-sm text-[#91a9c3]">{translate("web.helper.handoff")}</p>
      </Card>
    </main>
  );
}
