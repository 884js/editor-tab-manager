import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useLanguage } from "../hooks/useLanguage";

interface SettingsProps {
  onClose: () => void;
  notificationEnabled: boolean;
  onNotificationToggle: (enabled: boolean) => void;
  autostartEnabled: boolean;
  onAutostartToggle: (enabled: boolean) => void;
}

function highlightJSON(json: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  // Match: strings, numbers, booleans, null, or structural characters
  const regex = /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\]:,])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(json)) !== null) {
    // Add any unmatched text (whitespace) before this token
    if (match.index > lastIndex) {
      tokens.push(json.slice(lastIndex, match.index));
    }

    if (match[1] !== undefined) {
      // Key (string followed by colon)
      tokens.push(
        <span key={key++} style={{ color: "#9cdcfe" }}>{match[1]}</span>,
        json.slice(match.index + match[1].length, match.index + match[0].length), // the colon
      );
    } else if (match[2] !== undefined) {
      // String value
      tokens.push(<span key={key++} style={{ color: "#ce9178" }}>{match[2]}</span>);
    } else if (match[3] !== undefined) {
      // Number
      tokens.push(<span key={key++} style={{ color: "#b5cea8" }}>{match[3]}</span>);
    } else if (match[4] !== undefined) {
      // Boolean / null
      tokens.push(<span key={key++} style={{ color: "#b5cea8" }}>{match[4]}</span>);
    } else if (match[5] !== undefined) {
      // Structural character
      tokens.push(<span key={key++} style={{ color: "#808080" }}>{match[5]}</span>);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add any remaining text
  if (lastIndex < json.length) {
    tokens.push(json.slice(lastIndex));
  }

  return tokens;
}

const SETUP_CODE = `{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "echo \\"g $CLAUDE_PROJECT_DIR\\" >> /tmp/claude-code-events"
        }]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [{
          "type": "command",
          "command": "echo \\"g $CLAUDE_PROJECT_DIR\\" >> /tmp/claude-code-events"
        }]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{
          "type": "command",
          "command": "echo \\"w $CLAUDE_PROJECT_DIR\\" >> /tmp/claude-code-events"
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "echo \\"w $CLAUDE_PROJECT_DIR\\" >> /tmp/claude-code-events"
        }]
      }
    ]
  }
}`;

function Settings({ onClose, notificationEnabled, onNotificationToggle, autostartEnabled, onAutostartToggle }: SettingsProps) {
  const { t } = useTranslation();
  const { language, changeLanguage } = useLanguage();
  const [copied, setCopied] = useState(false);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [closeHover, setCloseHover] = useState(false);
  const [openFileHover, setOpenFileHover] = useState(false);
  const [collapseHover, setCollapseHover] = useState(false);
  const [copyHover, setCopyHover] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(SETUP_CODE);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  }, []);

  const handleOpenSettingsFile = useCallback(async () => {
    try {
      const home = await homeDir();
      const path = `${home}/.claude/settings.json`;
      await invoke("open_file_in_default_app", { path });
    } catch (error) {
      console.error("Failed to open settings file:", error);
    }
  }, []);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>{t("settings.title")}</h2>
        <button
          style={{
            ...styles.closeButton,
            ...(closeHover ? { color: "#ffffff" } : {}),
          }}
          onClick={onClose}
          onMouseEnter={() => setCloseHover(true)}
          onMouseLeave={() => setCloseHover(false)}
        >
          ×
        </button>
      </div>

      <div style={styles.content}>
        {/* Claude Code 連携 */}
        <div style={styles.card}>
          <h3 style={styles.sectionTitle}>{t("settings.claudeIntegration")}</h3>
          <p style={styles.description}>
            {t("settings.claudeDescription")}
          </p>

          {/* ステップ1 */}
          <div style={styles.stepRow}>
            <div style={styles.stepNumber}>1</div>
            <div style={styles.stepContent}>
              <span>{t("settings.step1Label")}</span>
              <button
                style={{
                  ...styles.openFileButton,
                  ...(openFileHover ? { background: "#333333" } : {}),
                }}
                onClick={handleOpenSettingsFile}
                onMouseEnter={() => setOpenFileHover(true)}
                onMouseLeave={() => setOpenFileHover(false)}
              >
                {t("settings.step1Button")}
              </button>
            </div>
          </div>

          {/* ステップ2 */}
          <div style={styles.stepRow}>
            <div style={styles.stepNumber}>2</div>
            <div style={styles.stepContent}>
              <span>{t("settings.step2Label")}</span>
              <div style={styles.collapseWrapper}>
                <div style={styles.collapseHeaderRow}>
                  <button
                    style={{
                      ...styles.collapseButton,
                      ...(collapseHover ? { background: "#3a3a3a" } : {}),
                    }}
                    onClick={() => setCodeExpanded(!codeExpanded)}
                    onMouseEnter={() => setCollapseHover(true)}
                    onMouseLeave={() => setCollapseHover(false)}
                  >
                    <span style={{
                      display: "inline-block",
                      transform: codeExpanded ? "rotate(90deg)" : "rotate(0deg)",
                      transition: "transform 0.15s ease",
                      marginRight: "6px",
                      fontSize: "10px",
                    }}>
                      ▶
                    </span>
                    {codeExpanded ? t("settings.hideCode") : t("settings.showCode")}
                  </button>
                  <button
                    style={{
                      ...styles.copyButton,
                      ...(copied ? { background: "#2ea043" } : {}),
                      ...(copyHover && !copied ? { background: "#0077ee" } : {}),
                    }}
                    onClick={handleCopy}
                    onMouseEnter={() => setCopyHover(true)}
                    onMouseLeave={() => setCopyHover(false)}
                  >
                    {copied ? t("settings.copied") : t("settings.copy")}
                  </button>
                </div>
                {codeExpanded && (
                  <pre style={styles.codeBlockExpanded} className="settings-code-block">
                    <code>{highlightJSON(SETUP_CODE)}</code>
                  </pre>
                )}
              </div>
            </div>
          </div>

          {/* ステップ3 */}
          <div style={styles.stepRow}>
            <div style={styles.stepNumber}>3</div>
            <div style={styles.stepContent}>
              <span>{t("settings.step3Label")}</span>
            </div>
          </div>

          {/* デスクトップ通知設定 */}
          <div style={{ borderTop: "1px solid #333333", paddingTop: "14px", marginTop: "2px" }}>
            <div style={styles.switchRow}>
              <div style={styles.switchLabelGroup}>
                <span style={styles.switchLabel}>{t("settings.notificationLabel")}</span>
                <span style={styles.switchDescription}>
                  {t("settings.notificationDescription")}
                </span>
              </div>
              <div
                style={{
                  ...styles.switchTrack,
                  ...(notificationEnabled ? styles.switchTrackActive : {}),
                }}
                onClick={() => onNotificationToggle(!notificationEnabled)}
              >
                <div
                  style={{
                    ...styles.switchThumb,
                    ...(notificationEnabled ? styles.switchThumbActive : {}),
                  }}
                />
              </div>
            </div>
            <p style={styles.note}>
              {t("settings.notificationNote")}
            </p>
          </div>
        </div>

        {/* 自動起動設定 */}
        <div style={styles.card}>
          <div style={styles.switchRow}>
            <div style={styles.switchLabelGroup}>
              <span style={styles.switchLabel}>{t("settings.autostartLabel")}</span>
              <span style={styles.switchDescription}>
                {t("settings.autostartDescription")}
              </span>
            </div>
            <div
              style={{
                ...styles.switchTrack,
                ...(autostartEnabled ? styles.switchTrackActive : {}),
              }}
              onClick={() => onAutostartToggle(!autostartEnabled)}
            >
              <div
                style={{
                  ...styles.switchThumb,
                  ...(autostartEnabled ? styles.switchThumbActive : {}),
                }}
              />
            </div>
          </div>
        </div>

        {/* 言語設定 */}
        <div style={styles.card}>
          <div style={styles.switchRow}>
            <div style={styles.switchLabelGroup}>
              <span style={styles.switchLabel}>{t("settings.language")}</span>
              <span style={styles.switchDescription}>
                {t("settings.languageDescription")}
              </span>
            </div>
            <select
              value={language.startsWith("ja") ? "ja" : "en"}
              onChange={(e) => changeLanguage(e.target.value)}
              style={styles.languageSelect}
            >
              <option value="ja">日本語</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: "#1e1e1e",
    color: "#ffffff",
    height: "100%",
    padding: "16px 20px",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: "12px",
    borderBottom: "1px solid #404040",
    flexShrink: 0,
  },
  content: {
    flex: 1,
    overflowY: "auto",
    paddingTop: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  title: {
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: 600,
    margin: 0,
  },
  closeButton: {
    background: "transparent",
    border: "none",
    color: "#a0a0a0",
    fontSize: "20px",
    cursor: "pointer",
    padding: "0 4px",
    lineHeight: 1,
    transition: "color 0.15s ease",
  },
  card: {
    background: "#252526",
    border: "1px solid #333333",
    borderRadius: "8px",
    padding: "16px",
  },
  sectionTitle: {
    color: "#ffffff",
    fontSize: "13px",
    fontWeight: 600,
    margin: "0 0 10px 0",
    paddingBottom: "8px",
    borderBottom: "1px solid #333333",
  },
  description: {
    color: "#cccccc",
    fontSize: "12px",
    lineHeight: 1.5,
    margin: "0 0 14px 0",
  },
  stepRow: {
    display: "flex",
    gap: "10px",
    marginBottom: "14px",
  },
  stepNumber: {
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    background: "#0066cc",
    color: "#ffffff",
    fontSize: "11px",
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: "1px",
  },
  stepContent: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    color: "#cccccc",
    fontSize: "12px",
    lineHeight: 1.5,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  openFileButton: {
    background: "transparent",
    border: "1px solid #555555",
    borderRadius: "4px",
    color: "#4da6ff",
    fontSize: "11px",
    padding: "6px 10px",
    cursor: "pointer",
    textAlign: "left" as const,
    transition: "background 0.15s ease",
    width: "fit-content",
  },
  collapseWrapper: {
    display: "flex",
    flexDirection: "column",
    gap: "0",
  },
  collapseHeaderRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  collapseButton: {
    background: "#2d2d2d",
    border: "1px solid #404040",
    borderRadius: "4px",
    color: "#cccccc",
    fontSize: "11px",
    padding: "6px 10px",
    cursor: "pointer",
    transition: "background 0.15s ease",
  },
  copyButton: {
    padding: "6px 12px",
    fontSize: "11px",
    background: "#0066cc",
    color: "#ffffff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    transition: "background 0.15s ease",
    whiteSpace: "nowrap",
  },
  codeBlockExpanded: {
    background: "#2d2d2d",
    padding: "12px",
    borderRadius: "0 0 6px 6px",
    fontSize: "11px",
    color: "#e0e0e0",
    overflow: "auto",
    maxHeight: "200px",
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    whiteSpace: "pre",
    border: "1px solid #404040",
    borderTop: "none",
    userSelect: "text",
    WebkitUserSelect: "text",
    cursor: "text",
    margin: "0",
    marginTop: "4px",
  },
  note: {
    color: "#606060",
    fontSize: "11px",
    margin: "0",
  },
  switchRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginBottom: "8px",
  },
  switchLabelGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    flex: 1,
  },
  switchLabel: {
    fontSize: "12px",
    color: "#ffffff",
  },
  switchDescription: {
    fontSize: "11px",
    color: "#888888",
  },
  switchTrack: {
    width: "40px",
    height: "22px",
    borderRadius: "11px",
    background: "#404040",
    cursor: "pointer",
    position: "relative",
    transition: "background 0.2s ease",
    flexShrink: 0,
  },
  switchTrackActive: {
    background: "#0066cc",
  },
  switchThumb: {
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    background: "#ffffff",
    position: "absolute",
    top: "2px",
    left: "2px",
    transition: "transform 0.2s ease",
  },
  switchThumbActive: {
    transform: "translateX(18px)",
  },
  languageSelect: {
    background: "#2d2d2d",
    color: "#ffffff",
    border: "1px solid #555555",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "12px",
    cursor: "pointer",
    flexShrink: 0,
  },
};

export default Settings;
