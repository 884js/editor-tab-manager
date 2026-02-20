const GITHUB_REPO = "884js/editor-tab-manager";

export interface LatestVersionInfo {
  version: string;
  url: string;
}

export function compareVersions(current: string, latest: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function fetchLatestVersion(): Promise<LatestVersionInfo> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { Accept: "application/vnd.github.v3+json" } },
  );
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }
  const data = await res.json();
  return {
    version: (data.tag_name as string).replace(/^v/, ""),
    url: data.html_url as string,
  };
}
