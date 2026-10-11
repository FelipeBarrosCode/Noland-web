const RELEASE_API = "https://api.github.com/repos/FelipeBarrosCode/Noland-web/releases/tags/noland-helper-latest";
export const HELPER_RELEASE_PAGE = "https://github.com/FelipeBarrosCode/Noland-web/releases/tag/noland-helper-latest";

type ReleaseAsset = { name: string; browser_download_url: string };

function expectedAsset(): RegExp | null {
  const fingerprint = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  const arm64 = /arm64|aarch64|macarm/u.test(fingerprint)
    || (/mac/u.test(fingerprint) && navigator.maxTouchPoints > 1);
  if (/mac/u.test(fingerprint)) {
    return arm64 ? /^Noland-Helper-macos-arm64\.dmg$/u : null;
  }
  if (/win/u.test(fingerprint)) return /^Noland-Helper-windows-x64-setup\.exe$/u;
  if (/linux|x11/u.test(fingerprint)) return /^Noland-Helper-linux-x64\.(?:deb|AppImage)$/u;
  return null;
}

export async function resolveHelperDownload(): Promise<string> {
  const pattern = expectedAsset();
  if (!pattern) return HELPER_RELEASE_PAGE;
  try {
    const response = await fetch(RELEASE_API, {
      headers: { accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!response.ok) return HELPER_RELEASE_PAGE;
    const release = await response.json() as { assets?: ReleaseAsset[] };
    const asset = release.assets?.find((candidate) => pattern.test(candidate.name));
    return asset?.browser_download_url ?? HELPER_RELEASE_PAGE;
  } catch {
    return HELPER_RELEASE_PAGE;
  }
}
