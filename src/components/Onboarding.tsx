import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

interface OnboardingProps {
  onComplete: (dontShowAgain: boolean) => void;
  hasAccessibilityPermission: boolean;
}

function Onboarding({ onComplete, hasAccessibilityPermission }: OnboardingProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(true);
  const [permissionGranted, setPermissionGranted] = useState(hasAccessibilityPermission);

  const totalSteps = 2;

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
        setPermissionGranted(true);
      }
    } catch (error) {
      console.error("Failed to check accessibility permission:", error);
    }
  };

  const handleNext = () => {
    if (step < totalSteps - 1) {
      setStep(step + 1);
    }
  };

  const handlePrev = () => {
    if (step > 0) {
      setStep(step - 1);
    }
  };

  const handleFinish = () => {
    onComplete(dontShowAgain);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        backgroundColor: "#1e1e1e",
        color: "#ffffff",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {/* Content area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px",
          overflow: "auto",
        }}
      >
        {step === 0 && <WelcomeStep />}
        {step === 1 && (
          <AccessibilityStep
            permissionGranted={permissionGranted}
            onOpenSettings={handleOpenSettings}
            onCheckPermission={handleCheckPermission}
          />
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: "20px 40px",
          borderTop: "1px solid #333333",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {/* Checkbox */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "13px",
            color: "#a0a0a0",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            style={{ accentColor: "#0066cc" }}
          />
          {t("onboarding.dontShowAgain")}
        </label>

        {/* Navigation */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {/* Step indicator */}
          <div style={{ display: "flex", gap: "6px", marginRight: "8px" }}>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor: i === step ? "#0066cc" : "#404040",
                  transition: "background-color 0.2s",
                }}
              />
            ))}
          </div>

          {step > 0 && (
            <button
              onClick={handlePrev}
              style={{
                padding: "8px 20px",
                fontSize: "13px",
                fontWeight: 500,
                color: "#a0a0a0",
                backgroundColor: "transparent",
                border: "1px solid #404040",
                borderRadius: "6px",
                cursor: "pointer",
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
              {t("onboarding.prev")}
            </button>
          )}

          {step < totalSteps - 1 ? (
            <button
              onClick={handleNext}
              style={{
                padding: "8px 20px",
                fontSize: "13px",
                fontWeight: 500,
                color: "#ffffff",
                backgroundColor: "#0066cc",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
              }}
              onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "#0055aa")}
              onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "#0066cc")}
            >
              {t("onboarding.next")}
            </button>
          ) : (
            <button
              onClick={handleFinish}
              style={{
                padding: "8px 20px",
                fontSize: "13px",
                fontWeight: 500,
                color: "#ffffff",
                backgroundColor: "#0066cc",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
              }}
              onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "#0055aa")}
              onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "#0066cc")}
            >
              {t("onboarding.finish")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  const { t } = useTranslation();

  return (
    <div style={{ maxWidth: "420px", textAlign: "center" }}>
      <img
        src="/app-icon.png"
        alt="Editor Tab Manager"
        style={{
          width: "96px",
          height: "96px",
          marginBottom: "24px",
          borderRadius: "20px",
        }}
      />
      <h1
        style={{
          fontSize: "24px",
          fontWeight: 600,
          marginBottom: "16px",
          color: "#ffffff",
        }}
      >
        {t("onboarding.welcomeTitle")}
      </h1>
      <p
        style={{
          fontSize: "14px",
          lineHeight: 1.7,
          color: "#a0a0a0",
        }}
      >
        {t("onboarding.welcomeDescription")}
      </p>
    </div>
  );
}

interface AccessibilityStepProps {
  permissionGranted: boolean;
  onOpenSettings: () => void;
  onCheckPermission: () => void;
}

function AccessibilityStep({
  permissionGranted,
  onOpenSettings,
  onCheckPermission,
}: AccessibilityStepProps) {
  const { t } = useTranslation();

  return (
    <div style={{ maxWidth: "420px", textAlign: "center" }}>
      <div style={{ fontSize: "48px", marginBottom: "24px" }}>
        {permissionGranted ? "✅" : "🔐"}
      </div>
      <h1
        style={{
          fontSize: "24px",
          fontWeight: 600,
          marginBottom: "16px",
          color: "#ffffff",
        }}
      >
        {t("onboarding.accessibilityTitle")}
      </h1>

      {permissionGranted ? (
        <p
          style={{
            fontSize: "14px",
            lineHeight: 1.7,
            color: "#4caf50",
          }}
        >
          {t("onboarding.accessibilityGranted")}
        </p>
      ) : (
        <>
          <p
            style={{
              fontSize: "14px",
              lineHeight: 1.7,
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
              onClick={onOpenSettings}
              style={{
                padding: "12px 24px",
                fontSize: "14px",
                fontWeight: 500,
                color: "#ffffff",
                backgroundColor: "#0066cc",
                border: "none",
                borderRadius: "8px",
                cursor: "pointer",
              }}
              onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "#0055aa")}
              onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "#0066cc")}
            >
              {t("accessibility.openSettings")}
            </button>
            <button
              onClick={onCheckPermission}
              style={{
                padding: "12px 24px",
                fontSize: "14px",
                fontWeight: 500,
                color: "#a0a0a0",
                backgroundColor: "transparent",
                border: "1px solid #404040",
                borderRadius: "8px",
                cursor: "pointer",
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
        </>
      )}
    </div>
  );
}

export default Onboarding;
