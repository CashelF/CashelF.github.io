import React from "react";

export const THEME_STORAGE_KEY = "cash-theme";
const ThemeContext = React.createContext({ theme: "light", toggleTheme: () => {} });
const isTheme = value => value === "light" || value === "dark";

function savedTheme() {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(saved) ? saved : null;
  } catch (error) {
    return null;
  }
}

function systemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }) {
  const [preference, setPreference] = React.useState(savedTheme);
  const [system, setSystem] = React.useState(systemTheme);
  const theme = preference || system;

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#181c19" : "#f6f5f1");
  }, [theme]);

  React.useEffect(() => {
    const media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    const change = event => setSystem(event.matches ? "dark" : "light");
    const storage = event => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setPreference(isTheme(event.newValue) ? event.newValue : null);
      }
    };
    if (media && media.addEventListener) media.addEventListener("change", change);
    else if (media && media.addListener) media.addListener(change);
    window.addEventListener("storage", storage);
    return () => {
      if (media && media.removeEventListener) media.removeEventListener("change", change);
      else if (media && media.removeListener) media.removeListener(change);
      window.removeEventListener("storage", storage);
    };
  }, []);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setPreference(next);
    try { window.localStorage.setItem(THEME_STORAGE_KEY, next); } catch (error) { /* Session-only when storage is unavailable. */ }
  };

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return React.useContext(ThemeContext); }
