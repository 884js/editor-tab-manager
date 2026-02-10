import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { load } from "@tauri-apps/plugin-store";
import type { Store } from "@tauri-apps/plugin-store";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load("tab-order.json");
  }
  return storePromise;
}

export function useLanguage() {
  const { i18n } = useTranslation();

  // Load saved language from Store on mount
  useEffect(() => {
    const loadLanguage = async () => {
      try {
        const store = await getStore();
        const saved = await store.get<string>("language");
        if (saved && saved !== i18n.language) {
          await i18n.changeLanguage(saved);
        }
      } catch {
        // default: use detected language
      }
    };
    loadLanguage();
  }, [i18n]);

  const changeLanguage = useCallback(
    async (lng: string) => {
      await i18n.changeLanguage(lng);
      try {
        const store = await getStore();
        await store.set("language", lng);
      } catch (error) {
        console.error("Failed to save language setting:", error);
      }
    },
    [i18n]
  );

  return { language: i18n.language, changeLanguage };
}
