// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";

type Theme = "dark" | "light";
const ThemeSetterContext = createContext<((next: Theme) => void) | null>(null);
// The server cannot see the saved choice, so it renders a neutral label.
const serverTheme = (): Theme | null => null;

function paintedTheme(): Theme {
  const root = document.documentElement;
  const attr = root.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") {
    return attr;
  }
  return root.classList.contains("dark") ? "dark" : "light";
}

function subscribeToPaintedTheme(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme", "class"] });
  return () => observer.disconnect();
}

/** Let the embedding app own theme persistence without depending on its theme library. */
export function ShellThemeProvider({ children, setTheme }: { children: ReactNode; setTheme: (next: Theme) => void }) {
  return <ThemeSetterContext.Provider value={setTheme}>{children}</ThemeSetterContext.Provider>;
}

export function ShellThemeButton() {
  const theme = useSyncExternalStore<Theme | null>(subscribeToPaintedTheme, paintedTheme, serverTheme);
  const setTheme = useContext(ThemeSetterContext);

  function toggle() {
    const target = paintedTheme() === "dark" ? "light" : "dark";
    if (setTheme) {
      setTheme(target);
      return;
    }
    const root = document.documentElement;
    root.setAttribute("data-theme", target);
    root.classList.toggle("dark", target === "dark");
  }

  return (
    <button
      className="rr-side__theme rr-chrome-btn"
      onClick={toggle}
      title={theme ? `Switch to ${theme === "dark" ? "light" : "dark"}` : undefined}
      type="button"
    >
      {theme === null ? "Theme" : theme === "dark" ? "Dark" : "Light"}
    </button>
  );
}
