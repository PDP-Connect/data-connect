// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { DcLogotype } from "@/components/icons/dc-logotype"
import { IconMcp } from "@/components/icons/icon-mcp"
import { topNavItemClassName } from "@/components/navigation/nav-item-styles"
import { navTooltipClassName } from "@/components/navigation/nav-tooltip"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ROUTES } from "@/config/routes"
import { cn } from "@/lib/classes"
import type { LucideIcon } from "lucide-react"
import { HomeIcon, UserRoundCogIcon, BoxIcon, WrenchIcon } from "lucide-react"
import type { CSSProperties } from "react"
import { NavLink } from "react-router-dom"

type NavItem = {
  id: "home" | "apps" | "docs" | "settings" | "server-repairs"
  to: string
  label: string
  Icon: LucideIcon | React.ComponentType<{ className?: string }>
  external?: boolean
}

const navIconClasses = "size-[18px]"

const navItems: NavItem[] = [
  { id: "home", to: ROUTES.home, label: "Home", Icon: HomeIcon },
  // { to: ROUTES.mcp, label: "MCP", Icon: IconMcp },
  // {
  //   id: "docs",
  //   to: "https://github.com/vana-com/data-connect",
  //   label: "Docs",
  //   Icon: BookOpenIcon,
  //   external: true,
  // },
  // { to: "/activity", label: "Activity", Icon: ActivityIcon },
  { id: "apps", to: ROUTES.apps, label: "Apps", Icon: BoxIcon },
  {
    id: "server-repairs",
    to: ROUTES.serverRepairs,
    label: "Server & Repairs",
    Icon: WrenchIcon,
  },
  {
    id: "settings",
    to: ROUTES.settings,
    label: "Settings",
    Icon: UserRoundCogIcon,
  },
]

export function TopNav() {
  return (
    <div data-component="top-nav" className="relative z-20 w-full">
      {/* spacer covering the dot pattern, sets the nav under the macOS traffic lights bar */}
      <div data-tauri-drag-region className="h-[28px] bg-muted"></div>
      <header
        data-tauri-drag-region
        className={cn(
          "h-[48px] px-inset",
          "backdrop-blur-sm flex items-center justify-between"
          // "border-t"
        )}
      >
        {/* Logo/Brand */}
        <NavLink
          to={ROUTES.home}
          className="h-full flex items-center gap-2"
          aria-label="Data Connect"
        >
          <DcLogotype
            height={12}
            style={
              {
                "--logo-stop-0": "var(--foreground)",
                "--logo-stop-1":
                  "color-mix(in oklab, var(--foreground) 50%, transparent)",
              } as CSSProperties
            }
          />
        </NavLink>

        {/* Navigation Icons */}
        <nav className="flex items-center gap-[3px]">
          {navItems.map(({ id, to, label, Icon, external }) => {
            const icon = (
              <span className="relative inline-flex">
                {Icon === IconMcp ? (
                  <IconMcp boxSize="18px" aria-hidden />
                ) : (
                  <Icon className={navIconClasses} aria-hidden />
                )}
              </span>
            )

            if (external) {
              return (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <a
                      href={to}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={label}
                      className={topNavItemClassName}
                    >
                      {icon}
                      <span className="sr-only">{label}</span>
                    </a>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className={navTooltipClassName}>
                    {label}
                  </TooltipContent>
                </Tooltip>
              )
            }
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <NavLink
                    to={to}
                    aria-label={label}
                    className={topNavItemClassName}
                  >
                    {icon}
                    <span className="sr-only">{label}</span>
                  </NavLink>
                </TooltipTrigger>
                <TooltipContent side="bottom" className={navTooltipClassName}>
                  {label}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </nav>
      </header>

      {/* Gradient fade below nav */}
      <div
        className="pointer-events-none absolute left-0 right-0 top-full h-20 bg-linear-to-b from-muted to-transparent"
        aria-hidden="true"
      />
    </div>
  )
}
