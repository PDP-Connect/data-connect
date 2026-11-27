"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { DAY_COOKIE } from "./day-cut.ts";
export function useDayCut() {
  const router = useRouter();
  useEffect(() => {
    const offset = String(-new Date().getTimezoneOffset());
    const current = document.cookie.split("; ").find(value => value.startsWith(`${DAY_COOKIE}=`))?.split("=")[1];
    if (current !== offset) {
      document.cookie = `${DAY_COOKIE}=${offset}; Path=/; Max-Age=31536000; SameSite=Lax`;
      router.refresh();
    }
  }, [router]);
}
