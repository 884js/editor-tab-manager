import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";

interface SettingsProps {
  onClose: () => void;
  notificationEnabled: boolean;
  onNotificationToggle: (enabled: boolean) => void;
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

function Settings({ onClose, notificationEnabled, onNotificationToggle }: SettingsProps) {
  const [copied, setCopied] = useState(false);

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
        <h2 style={styles.title}>設定</h2>
        <button style={styles.closeButton} onClick={onClose}>×</button>
      </div>

      <div style={styles.content}>
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Claude Code 通知連携</h3>

          <p style={styles.description}>
            Claude Codeがユーザー入力待ちになったときに、タブバーに通知バッジを表示します。
          </p>

          <p style={styles.descriptionSmall}>
            この機能を使うには、Claude Codeの設定ファイル（
            <span style={styles.link} onClick={handleOpenSettingsFile}>
              ~/.claude/settings.json
            </span>
            ）に以下を追加してください。
          </p>

          <div style={styles.codeContainer}>
            <pre style={styles.codeBlock} className="settings-code-block">{SETUP_CODE}</pre>
            <button
              style={styles.copyButton}
              onClick={handleCopy}
            >
              {copied ? "コピーしました" : "コピー"}
            </button>
          </div>

          <p style={styles.note}>
            設定後、Claude Codeを再起動してください。
          </p>
        </div>

        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>デスクトップ通知</h3>
          <div style={styles.switchRow}>
            <span style={styles.switchLabel}>
              Claude Code生成完了時にデスクトップ通知を表示
            </span>
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
            エディタが前面にあるときは通知されません（タブバーのバッジで確認できます）。
          </p>
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
  },
  section: {
    marginBottom: "16px",
  },
  sectionTitle: {
    color: "#ffffff",
    fontSize: "13px",
    fontWeight: 600,
    margin: "0 0 8px 0",
  },
  description: {
    color: "#ffffff",
    fontSize: "12px",
    lineHeight: 1.5,
    marginBottom: "6px",
  },
  descriptionSmall: {
    color: "#a0a0a0",
    fontSize: "11px",
    lineHeight: 1.5,
    marginBottom: "12px",
  },
  codeContainer: {
    position: "relative",
    marginBottom: "12px",
  },
  codeBlock: {
    background: "#2d2d2d",
    padding: "12px",
    borderRadius: "6px",
    fontSize: "11px",
    color: "#e0e0e0",
    overflow: "auto",
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    whiteSpace: "pre",
    border: "1px solid #404040",
    userSelect: "text",
    WebkitUserSelect: "text",
    cursor: "text",
    margin: 0,
  },
  copyButton: {
    position: "absolute",
    top: "8px",
    right: "8px",
    padding: "4px 10px",
    fontSize: "11px",
    background: "#0066cc",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
  },
  note: {
    color: "#606060",
    fontSize: "11px",
    marginBottom: "0",
  },
  link: {
    color: "#4da6ff",
    cursor: "pointer",
    textDecoration: "underline",
  },
  switchRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  switchLabel: {
    fontSize: "12px",
    color: "#ffffff",
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
};

export default Settings;
