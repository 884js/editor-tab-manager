import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { fetchLatestVersion, compareVersions } from "../utils/version";

const GITHUB_REPO_URL = "https://github.com/884js/editor-tab-manager";

type UpdateStatus =
  | { state: "checking" }
  | { state: "available"; version: string; url: string }
  | { state: "upToDate" }
  | { state: "error" };

function VersionInfo() {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "checking" });
  const [updateBtnHover, setUpdateBtnHover] = useState(false);
  const [githubHover, setGithubHover] = useState(false);

  const handleOpenGitHub = useCallback(() => {
    invoke("open_file_in_default_app", { path: GITHUB_REPO_URL });
  }, []);

  useEffect(() => {
    getVersion().then(setAppVersion);
    fetchLatestVersion()
      .then((latest) => {
        getVersion().then((current) => {
          if (compareVersions(current, latest.version) < 0) {
            setUpdateStatus({ state: "available", version: latest.version, url: latest.url });
          } else {
            setUpdateStatus({ state: "upToDate" });
          }
        });
      })
      .catch(() => setUpdateStatus({ state: "error" }));
  }, []);

  return (
    <div style={styles.card}>
      <div style={styles.row}>
        <div style={styles.labelGroup}>
          <span style={styles.label}>{t("settings.version")}</span>
          <span style={styles.description}>v{appVersion}</span>
        </div>
        <div>
          {updateStatus.state === "checking" && (
            <span style={styles.checking}>{t("settings.checkingUpdate")}</span>
          )}
          {updateStatus.state === "upToDate" && (
            <span style={styles.upToDate}>{t("settings.upToDate")}</span>
          )}
          {updateStatus.state === "available" && (
            <button
              style={{
                ...styles.updateButton,
                ...(updateBtnHover ? { background: "#0077ee" } : {}),
              }}
              onClick={() =>
                invoke("open_file_in_default_app", { path: updateStatus.url })
              }
              onMouseEnter={() => setUpdateBtnHover(true)}
              onMouseLeave={() => setUpdateBtnHover(false)}
            >
              {t("settings.updateAvailable", { version: updateStatus.version })}
            </button>
          )}
          {updateStatus.state === "error" && (
            <span style={styles.checking}>-</span>
          )}
        </div>
      </div>

      {/* GitHub リポジトリリンク */}
      <div style={styles.row}>
        <div style={styles.labelGroup}>
          <span style={styles.label}>{t("settings.githubRepo")}</span>
          <span style={styles.description}>{GITHUB_REPO_URL}</span>
        </div>
        <button
          style={{
            ...styles.githubButton,
            ...(githubHover ? { background: "#333333" } : {}),
          }}
          onClick={handleOpenGitHub}
          onMouseEnter={() => setGithubHover(true)}
          onMouseLeave={() => setGithubHover(false)}
        >
          ↗
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "#252526",
    border: "1px solid #333333",
    borderRadius: "8px",
    padding: "16px",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginBottom: "8px",
  },
  labelGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    flex: 1,
  },
  label: {
    fontSize: "12px",
    color: "#ffffff",
  },
  description: {
    fontSize: "11px",
    color: "#888888",
  },
  checking: {
    fontSize: "11px",
    color: "#888888",
  },
  upToDate: {
    fontSize: "11px",
    color: "#4caf50",
  },
  updateButton: {
    background: "#0066cc",
    color: "#ffffff",
    border: "none",
    borderRadius: "4px",
    padding: "4px 10px",
    fontSize: "11px",
    cursor: "pointer",
    transition: "background 0.15s ease",
    whiteSpace: "nowrap",
  },
  githubButton: {
    background: "transparent",
    border: "1px solid #555555",
    borderRadius: "4px",
    color: "#4da6ff",
    fontSize: "14px",
    padding: "2px 8px",
    cursor: "pointer",
    transition: "background 0.15s ease",
    lineHeight: 1,
  },
};

export default VersionInfo;
