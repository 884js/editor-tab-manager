import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ja from "./locales/ja.json";
import en from "./locales/en.json";

i18n.use(initReactI18next).init({
  resources: {
    ja: { translation: ja },
    en: { translation: en },
  },
  lng: navigator.language,
  supportedLngs: ["ja", "en"],
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
