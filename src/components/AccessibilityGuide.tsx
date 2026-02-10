import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

interface AccessibilityGuideProps {
  onPermissionGranted: () => void;
}

function AccessibilityGuide({ onPermissionGranted }: AccessibilityGuideProps) {
  const { t } = useTranslation();

  const handleOpenSettings = async () => {
    try {
      await invoke("open_accessibility_settings");
    } catch (error) {
      console.error("Failed to open accessibility settings:", error);
    }
  };

  const handleCheckPermission = async () => {
    try {
      const hasPermission = await invoke<boolean>("check_accessibility_permission");
      if (hasPermission) {
        onPermissionGranted();
      }
    } catch (error) {
      console.error("Failed to check accessibility permission:", error);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        padding: "40px",
        backgroundColor: "#1e1e1e",
        color: "#ffffff",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: "480px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: "48px",
            marginBottom: "24px",
          }}
        >
          🔐
        </div>
        <h1
          style={{
            fontSize: "24px",
            fontWeight: 600,
            marginBottom: "16px",
            color: "#ffffff",
          }}
        >
          {t("accessibility.title")}
        </h1>
        <p
          style={{
            fontSize: "14px",
            lineHeight: 1.6,
            color: "#a0a0a0",
            marginBottom: "32px",
          }}
        >
          {t("accessibility.description")}
        </p>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <button
            onClick={handleOpenSettings}
            style={{
              padding: "12px 24px",
              fontSize: "14px",
              fontWeight: 500,
              color: "#ffffff",
              backgroundColor: "#0066cc",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              transition: "background-color 0.2s",
            }}
            onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "#0055aa")}
            onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "#0066cc")}
          >
            {t("accessibility.openSettings")}
          </button>
          <button
            onClick={handleCheckPermission}
            style={{
              padding: "12px 24px",
              fontSize: "14px",
              fontWeight: 500,
              color: "#a0a0a0",
              backgroundColor: "transparent",
              border: "1px solid #404040",
              borderRadius: "8px",
              cursor: "pointer",
              transition: "border-color 0.2s, color 0.2s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.borderColor = "#606060";
              e.currentTarget.style.color = "#ffffff";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.borderColor = "#404040";
              e.currentTarget.style.color = "#a0a0a0";
            }}
          >
            {t("accessibility.checkPermission")}
          </button>
        </div>
        <p
          style={{
            fontSize: "12px",
            color: "#606060",
            marginTop: "24px",
          }}
        >
          {t("accessibility.instructions")}
        </p>
      </div>
    </div>
  );
}

export default AccessibilityGuide;
