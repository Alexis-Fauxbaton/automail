import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

// Language is managed server-side via UserPreference (app.tsx loader → i18n.changeLanguage).
// No browser/localStorage detection — avoids stale "en" overriding the DB preference.
// Clear the key that the old LanguageDetector may have cached in localStorage.
if (typeof window !== "undefined") {
  localStorage.removeItem("i18nextLng");
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
