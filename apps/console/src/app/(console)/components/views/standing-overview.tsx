// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@pdpp/brand-react";
import "@pdpp/brand-react/components.css";
import { buttonVariants } from "@pdpp/operator-ui/ui/button";
import { cn } from "@pdpp/operator-ui/ui/utils";
import Link from "next/link";
import { ConnectorMark } from "../connector-mark.tsx";
import { SourceStatusText } from "../source-status-text.tsx";
import type { HomeData, HomeNeedRow, HomeSourceRow } from "./standing-view-model.ts";

const FILLED_BUTTON = buttonVariants({
  className: "h-[30px] rounded-[6px] px-2.5 text-[13px]",
  size: "default",
  variant: "default",
});

// Lead decision (home-pictures 3): every button in the needs-you box is outlined;
// the box itself is the emphasis. DIRECTION.md, Values: buttons use the stronger line.
const OUTLINED_BUTTON = cn(
  buttonVariants({ size: "default", variant: "outline" }),
  "h-[30px] rounded-[6px] border-border-strong px-2.5 text-[13px] dark:border-border-strong"
);

const SECTION_LABEL = "text-[13px] font-medium text-muted-foreground";
const SECOND_LINE = "text-[13px] leading-5 text-muted-foreground";
const FAINT_TEXT = "text-[color:var(--foreground-faint)]";

function LogoTile({ iconId, name, size = "small" }: { iconId: string; name: string; size?: "large" | "small" }) {
  const dimensions = size === "large" ? "size-10" : "size-8";

  return (
    <span
      aria-hidden="true"
      className={`${dimensions} inline-flex shrink-0 items-center justify-center rounded-[26%] border border-border bg-muted`}
    >
      <ConnectorMark connectorId={iconId} name={name} />
    </span>
  );
}

function DemoNotice({ notice }: { notice?: string }) {
  return notice ? (
    <Text as="p" className="mb-3 text-[13px] text-muted-foreground">
      {notice}
    </Text>
  ) : null;
}

function PageWarning({ href }: { href: string }) {
  return (
    <Text as="p" className="mb-5 text-[13px] text-muted-foreground">
      Some information could not be checked or may be out of date.{" "}
      <Link
        className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href={href}
      >
        Check server status
      </Link>
      .
    </Text>
  );
}

function PageHeading({
  data,
  notice,
  showSubtitle = true,
}: {
  data: HomeData;
  notice?: string;
  showSubtitle?: boolean;
}) {
  // Lead decision (home-pictures 8): the title starts where the /sources title
  // starts; the demo notice sits under the title there too.
  return (
    <header className="mb-8">
      {data.warning ? <PageWarning href={data.deploymentHref} /> : null}
      <Text
        as="h1"
        className="font-semibold text-[23px] text-foreground leading-tight tracking-[-0.022em] min-[860px]:text-[26px]"
      >
        {data.title}
      </Text>
      {showSubtitle && data.subtitle ? (
        <Text as="p" className="mt-2 text-[13px] text-muted-foreground tabular-nums">
          {data.subtitle}
        </Text>
      ) : null}
      {notice ? (
        <Text as="p" className="mt-3 text-[13px] text-muted-foreground">
          {notice}
        </Text>
      ) : null}
      {data.noSources ? (
        <Link className={`${FILLED_BUTTON} mt-4`} href={data.addSourceHref}>
          Add a data source
        </Link>
      ) : null}
      {data.summaryError ? <ReadFailure href={data.reloadHref} /> : null}
    </header>
  );
}

function ReadFailure({ href }: { href: string }) {
  return (
    <Text as="p" className={SECOND_LINE}>
      This could not be loaded.{" "}
      <Link
        className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href={href}
      >
        Try again
      </Link>
    </Text>
  );
}

function NeedLines({ need }: { need: HomeNeedRow }) {
  if (need.kind === "approval") {
    return (
      <>
        <Text as="p" className="text-[15px] text-foreground leading-5">
          <strong className="font-medium">{need.name}</strong> is asking to read your data
        </Text>
        {need.detail ? (
          <Text as="p" className={`${SECOND_LINE} mt-0.5 tabular-nums`}>
            {need.detail}
          </Text>
        ) : null}
      </>
    );
  }

  // Lead decision (home-pictures 1): two lines, the name, then the status words
  // and, only when there is one, the sync time in faint text.
  return (
    <>
      <Text as="p" className="truncate font-medium text-[15px] text-foreground leading-5">
        {need.name}
      </Text>
      {need.status && need.source ? (
        <Text as="p" className="mt-0.5 text-[13px] leading-5">
          <span data-source-id={need.source.connection_id} data-status-row={need.status.row}>
            <SourceStatusText status={need.status} />
          </span>
          {need.syncNote ? (
            <span className={`${FAINT_TEXT} tabular-nums`}>
              <span className="hidden min-[560px]:inline"> · </span>
              <span className="block whitespace-nowrap min-[560px]:inline">{need.syncNote}</span>
            </span>
          ) : null}
        </Text>
      ) : null}
    </>
  );
}

function NeedRow({ need }: { need: HomeNeedRow }) {
  // Lead decision (home-pictures 4): under 560px the button sits beneath the
  // text, aligned with it, instead of squeezing the text into a narrow column.
  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 px-3 py-3 min-[560px]:grid-cols-[2rem_minmax(0,1fr)_auto]">
      <LogoTile iconId={need.iconId} name={need.name} />
      <div className="min-w-0">
        <NeedLines need={need} />
      </div>
      {need.actionLabel ? (
        <Link
          className={`${OUTLINED_BUTTON} col-start-2 justify-self-start min-[560px]:col-start-3 min-[560px]:justify-self-end`}
          href={need.actionHref}
        >
          {need.actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

function NeedsBlock({ data }: { data: HomeData }) {
  if (!data.needsVisible) {
    return null;
  }

  return (
    <section aria-labelledby="home-needs-heading" className="mb-8">
      <Text as="h2" className={`${SECTION_LABEL} mb-2`} id="home-needs-heading">
        Needs you
      </Text>
      <div className="overflow-hidden rounded-md border border-border-strong">
        {data.needs.length > 0 ? (
          <div className="divide-y divide-border/70">
            {data.needs.map((need) => (
              <NeedRow key={need.id} need={need} />
            ))}
          </div>
        ) : null}
        {data.needsError ? (
          <div className={data.needs.length > 0 ? "border-border/70 border-t px-3 py-3" : "px-3 py-3"}>
            <ReadFailure href={data.reloadHref} />
          </div>
        ) : null}
        {data.needsMore ? (
          <div className={data.needs.length > 0 ? "border-border/70 border-t px-3 py-3" : "px-3 py-3"}>
            <Link
              className="text-[13px] text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={data.allAppsHref}
            >
              All apps
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DataSourceRow({ source }: { source: HomeSourceRow }) {
  return (
    <Link
      className="flex min-w-0 items-center justify-between gap-3 border-border/70 border-b py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={source.href}
    >
      <span className="flex min-w-0 items-center gap-3">
        <LogoTile iconId={source.source.connector_id} name={source.name} />
        <span className="min-w-0">
          <Text as="span" className="block truncate font-medium text-[15px] text-foreground">
            {source.name}
          </Text>
          <span
            className="block text-[13px] leading-5 min-[560px]:hidden"
            data-source-id={source.source.connection_id}
            data-status-row={source.status.row}
          >
            <SourceStatusText status={source.status} />
          </span>
        </span>
      </span>
      <span
        className="hidden min-[560px]:inline"
        data-source-id={source.source.connection_id}
        data-status-row={source.status.row}
      >
        <SourceStatusText className="whitespace-nowrap" status={source.status} />
      </span>
    </Link>
  );
}

function DataSourcesBlock({ data }: { data: HomeData }) {
  return (
    <section aria-labelledby="home-sources-heading">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <Text as="h2" className={SECTION_LABEL} id="home-sources-heading">
          Data sources
        </Text>
        <Link
          className="text-[13px] text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={data.addSourceHref}
        >
          Add a data source
        </Link>
      </div>

      {data.dataSourceError ? <ReadFailure href={data.reloadHref} /> : null}
      {!data.dataSourceError && data.dataSources.length > 0 ? (
        <div>
          {data.dataSources.map((source) => (
            <DataSourceRow key={source.id} source={source} />
          ))}
        </div>
      ) : null}
      {!data.dataSourceError && data.dataSources.length === 0 && !data.firstRun && !data.noSources ? (
        <Text as="p" className={SECOND_LINE}>
          No active data sources.
        </Text>
      ) : null}
      {data.sourceTotalLink ? (
        <div className="border-border/70 border-t py-3">
          <Link
            className="text-[13px] text-primary tabular-nums underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={data.sourcesHref}
          >
            {data.sourceTotalLink}
          </Link>
        </div>
      ) : data.showMoreSources ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-border/70 border-t py-3">
          <Text as="p" className={`${SECOND_LINE} tabular-nums`}>
            Showing {data.shownSourceCount.toLocaleString("en-US")} of your data sources.
          </Text>
          <Link
            className="text-[13px] text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={data.sourcesHref}
          >
            All data sources
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function AppRow({ app }: { app: HomeData["apps"][number] }) {
  return (
    <Link
      className="block border-border/70 border-b py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={app.href}
    >
      <Text as="span" className="text-[15px]">
        {app.name}
      </Text>
      <Text as="span" className={SECOND_LINE}>
        {" "}
        · {app.lastRead ? <>Last read {app.lastRead}</> : "Has not read anything yet"}
      </Text>
    </Link>
  );
}

function AppsBlock({ data }: { data: HomeData }) {
  return (
    <section aria-labelledby="home-apps-heading">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <Text as="h2" className={SECTION_LABEL} id="home-apps-heading">
          {data.appError ? "Apps" : `${data.apps.length} ${data.apps.length === 1 ? "app" : "apps"} can read your data`}
        </Text>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {data.allAppsLink ? (
            <Link
              className="text-[13px] text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={data.allAppsHref}
            >
              All apps
            </Link>
          ) : null}
          {data.allTokensLink ? (
            <Link
              className="text-[13px] text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={data.tokensHref}
            >
              All access tokens
            </Link>
          ) : null}
          <Link className={FILLED_BUTTON} href={data.appsHref}>
            Connect an app
          </Link>
        </div>
      </div>

      {data.apps.slice(0, 3).map((app) => (
        <AppRow app={app} key={app.id} />
      ))}
      {data.apps.length > 3 ? (
        <Link className={`${SECOND_LINE} block py-3`} href={data.allAppsHref}>
          and {data.apps.length - 3} more
        </Link>
      ) : null}
      {data.activeTokenCount > 0 ? (
        // Lead decision (home-pictures 7): a quiet line under the apps, not set like an app name.
        <Link
          className={`${SECOND_LINE} block py-3 tabular-nums underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          href={data.tokensHref}
        >
          {data.activeTokenCount.toLocaleString("en-US")}{" "}
          {data.activeTokenCount === 1 ? "sign-in key can" : "sign-in keys can"} read everything
        </Link>
      ) : null}
      {data.appsEmpty ? (
        <Text as="p" className={`${SECOND_LINE} py-3`}>
          No app can read your data yet. ChatGPT, Claude and other assistants read only what you allow.
        </Text>
      ) : null}
      {data.appError ? <ReadFailure href={data.reloadHref} /> : null}
    </section>
  );
}

function FirstRun({ data, notice }: { data: HomeData; notice?: string }) {
  return (
    <div className="mx-auto max-w-2xl py-8">
      <DemoNotice notice={notice} />
      {data.warning ? <PageWarning href={data.deploymentHref} /> : null}
      <div aria-hidden="true" className="mb-7 flex items-center gap-3">
        {["amazon", "facebook", "gmail", "notion", "spotify"].map((iconId) => (
          <LogoTile iconId={iconId} key={iconId} name={iconId} size="large" />
        ))}
      </div>
      <Text
        as="h1"
        className="font-semibold text-[23px] text-foreground leading-tight tracking-[-0.022em] min-[860px]:text-[26px]"
      >
        {data.title}
      </Text>
      <Text as="p" className="mt-3 max-w-xl text-[16px] text-foreground leading-6">
        DataConnect keeps a copy of your own data on a computer you choose and shows how current it is. Later you choose
        which apps and assistants may read it.
      </Text>
      <Link className={`${FILLED_BUTTON} mt-6`} href={data.addSourceHref}>
        Add a data source
      </Link>
      {data.summaryError ? <ReadFailure href={data.reloadHref} /> : null}
    </div>
  );
}

export function StandingOverview({ data, notice }: { data: HomeData; notice?: string }) {
  if (data.firstRun) {
    return <FirstRun data={data} notice={notice} />;
  }

  return (
    <div className="mx-auto max-w-6xl pb-8">
      <PageHeading data={data} notice={notice} />
      <div className="grid gap-10 min-[860px]:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          <NeedsBlock data={data} />
          <DataSourcesBlock data={data} />
        </div>
        <div className="min-w-0">
          <AppsBlock data={data} />
        </div>
      </div>
    </div>
  );
}
