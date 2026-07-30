import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ROUTES } from "@/config/routes"
import type { TimelineDataSource } from "@/apps/timeline/timeline-data-source"
import type { LocalTimelineConsentRequest } from "@/services/pdppTimeline"
import { Timeline } from "./index"

function renderTimeline(dataSource?: TimelineDataSource) {
  const router = createMemoryRouter(
    [{ path: ROUTES.timeline, element: <Timeline dataSource={dataSource} /> }],
    { initialEntries: [ROUTES.timeline] }
  )

  return render(<RouterProvider router={router} />)
}

const readyDataSource: TimelineDataSource = {
  read: vi.fn().mockResolvedValue({
    kind: "ready",
    read: {
      streams: [
        {
          stream: {
            id: "messages",
            label: "Messages",
            fields: [
              { name: "createdAt", format: "date-time" },
              { name: "title" },
            ],
            primaryKey: [],
            timestampFields: ["createdAt"],
          },
          records: [
            {
              id: "message-1",
              data: {
                createdAt: "2026-07-30T15:00:00Z",
                title: "A message from the archive",
              },
            },
          ],
          hasMore: false,
        },
        {
          stream: {
            id: "notes",
            label: "Notes",
            fields: [{ name: "text" }],
            primaryKey: [],
            timestampFields: [],
          },
          records: [{ id: "note-1", data: { text: "A note without a date" } }],
          hasMore: false,
        },
      ],
    },
  }),
}

const localTimelineTerms: LocalTimelineConsentRequest = {
  request_id: "request-1",
  session_id: "timeline-session",
  subject_id: "timeline-subject",
  scopes: ["pdpp.local.github.repositories", "pdpp.local.github.gists"],
  access_expires_in_seconds: 28_800,
  authorization_details: {
    type: "https://pdpp.org/data-access",
    source: { kind: "connector", id: "github" },
    access_mode: "continuous",
    purpose_code: "https://dataconnect.app/purposes/timeline",
    purpose_description:
      "Show your connected records in DataConnect's local Timeline.",
    retention: { max_duration: "P30D", on_expiry: "delete" },
    streams: [{ name: "repositories" }, { name: "gists" }],
  },
}

afterEach(() => {
  cleanup()
})

describe("Timeline", () => {
  it("renders a bounded, grouped timeline with an honest undated section", async () => {
    renderTimeline(readyDataSource)

    expect(screen.getByText("Loading timeline…")).toBeTruthy()

    await waitFor(() => {
      expect(screen.getByText("2 records loaded")).toBeTruthy()
    })

    expect(screen.getByText("A message from the archive")).toBeTruthy()
    expect(screen.getByText(/Messages · .*UTC/)).toBeTruthy()
    expect(screen.getByText("No usable date")).toBeTruthy()
    expect(screen.getByText("A note without a date")).toBeTruthy()
    expect(
      screen.getByRole("combobox", { name: /filter timeline/i })
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("combobox", { name: /filter timeline/i }))
    fireEvent.click(screen.getByRole("option", { name: "Notes" }))

    await waitFor(() => {
      expect(screen.getByText("Showing 1 of 2 loaded records")).toBeTruthy()
    })
    expect(screen.queryByText("A message from the archive")).toBeNull()
  })

  it("shows unauthorized and revoked source states", async () => {
    const { rerender } = renderTimeline({
      read: vi.fn().mockResolvedValue({ kind: "unauthorized" }),
    })

    await waitFor(() => {
      expect(screen.getByText("Sign in to view your timeline.")).toBeTruthy()
    })

    const revokedSource: TimelineDataSource = {
      read: vi.fn().mockResolvedValue({ kind: "revoked" }),
    }
    const router = createMemoryRouter(
      [
        {
          path: ROUTES.timeline,
          element: <Timeline dataSource={revokedSource} />,
        },
      ],
      { initialEntries: [ROUTES.timeline] }
    )
    rerender(<RouterProvider router={router} />)

    await waitFor(() => {
      expect(
        screen.getByText("Timeline access has expired or been revoked.")
      ).toBeTruthy()
    })
  })

  it("shows normalized terms before explicit approval and cancellation issues no grant", async () => {
    const requestConsent = vi.fn().mockResolvedValue(localTimelineTerms)
    const approveConsent = vi.fn().mockResolvedValue(undefined)
    const source: TimelineDataSource = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ kind: "unauthorized" })
        .mockResolvedValueOnce({ kind: "ready", read: { streams: [] } }),
      requestConsent,
      approveConsent,
    }
    renderTimeline(source)

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /review local timeline access/i })
      ).toBeTruthy()
    })
    fireEvent.click(
      screen.getByRole("button", { name: /review local timeline access/i })
    )
    await waitFor(() => expect(requestConsent).toHaveBeenCalledOnce())
    expect(screen.getByText("Review Timeline access")).toBeTruthy()
    expect(screen.getByText("repositories")).toBeTruthy()
    expect(screen.getByText("gists")).toBeTruthy()
    expect(screen.getByText(/continuous access/i)).toBeTruthy()
    expect(screen.getByText(/P30D; delete on expiry/i)).toBeTruthy()
    expect(screen.getByText(/expires 8 hours after approval/i)).toBeTruthy()
    expect(approveConsent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(approveConsent).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: /review local timeline access/i })
    ).toBeTruthy()
  })

  it("issues the local grant only after the owner approves loaded terms", async () => {
    const requestConsent = vi.fn().mockResolvedValue(localTimelineTerms)
    const approveConsent = vi.fn().mockResolvedValue(undefined)
    renderTimeline({
      read: vi
        .fn()
        .mockResolvedValueOnce({ kind: "unauthorized" })
        .mockResolvedValueOnce({ kind: "ready", read: { streams: [] } }),
      requestConsent,
      approveConsent,
    })

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /review local timeline access/i })
      ).toBeTruthy()
    })
    fireEvent.click(
      screen.getByRole("button", { name: /review local timeline access/i })
    )
    await screen.findByRole("button", {
      name: /approve local timeline access/i,
    })
    expect(approveConsent).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: /approve local timeline access/i })
    )
    await waitFor(() => {
      expect(approveConsent).toHaveBeenCalledWith(localTimelineTerms)
    })
  })

  it("shows an honest unavailable state without using fixtures", async () => {
    renderTimeline({
      read: vi.fn().mockResolvedValue({
        kind: "error",
        code: "unavailable",
        message: "Timeline is waiting for your local Personal Server.",
        retryable: true,
      }),
    })

    await waitFor(() => {
      expect(
        screen.getByText("Timeline is waiting for your local Personal Server.")
      ).toBeTruthy()
    })
    expect(screen.getByText("No records are shown.")).toBeTruthy()
  })
})
