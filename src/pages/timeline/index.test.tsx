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
      expect(screen.getByText("Timeline access has been revoked.")).toBeTruthy()
    })
  })

  it("keeps production free of fixtures by showing the unavailable state", async () => {
    renderTimeline()

    await waitFor(() => {
      expect(
        screen.getByText(
          "Timeline reads are not connected to your Personal Server yet."
        )
      ).toBeTruthy()
    })
    expect(screen.getByText("No records are shown.")).toBeTruthy()
  })
})
