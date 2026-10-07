// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import localFont from "next/font/local";

export const brandSans = localFont({
  display: "swap",
  src: [
    {
      path: "../../../../public/fonts/InterVariable.ttf",
      style: "normal",
      weight: "100 900",
    },
    {
      path: "../../../../public/fonts/InterVariable-Italic.ttf",
      style: "italic",
      weight: "100 900",
    },
  ],
  variable: "--font-pdpp-sans",
});

export const brandMono = localFont({
  display: "swap",
  src: "../fonts/JetBrainsMono-Variable.ttf",
  variable: "--font-pdpp-mono",
  weight: "100 800",
});
