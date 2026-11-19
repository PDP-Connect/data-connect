// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";

type Theme = "dark" | "light";
const ThemeSetterContext = createContext<((next: Theme) => void) | null>(null);
const serverTheme = (): Theme => "dark";

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
  const theme = useSyncExternalStore(subscribeToPaintedTheme, paintedTheme, serverTheme);
  const setTheme = useContext(ThemeSetterContext);
  const next = theme === "dark" ? "light" : "dark";

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
    <button className="rr-side__theme rr-chrome-btn" onClick={toggle} title={`Switch to ${next}`} type="button">
      {theme === "dark" ? "Dark" : "Light"}
    </button>
  );
}
