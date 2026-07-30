import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useSourceOverviewPage } from "./use-source-overview-page"

let mockState: {
  app: {
    runs: Array<Record<string, unknown>>
    platforms: Array<Record<string, unknown>>
  }
}

const mockGetUserDataPath = vi.fn()
const mockOpenPlatformExportFolder = vi.fn()
const mockLoadLatestSourceExportPreview = vi.fn()
const mockLoadLatestSourceExportFull = vi.fn()
const mockLoadSourceExportPreviewFromPath = vi.fn()
const mockLoadSourceExportFullFromPath = vi.fn()
const mockOpenExportFolderPath = vi.fn()
const silenceConsoleError = () =>
  vi.spyOn(console, "error").mockImplementation(() => {})

vi.mock("react-redux", () => ({
  useSelector: (selector: (state: typeof mockState) => unknown) =>
    selector(mockState),
}))

vi.mock("@/lib/tauri-paths", () => ({
  getUserDataPath: () => mockGetUserDataPath(),
  openPlatformExportFolder: (...args: unknown[]) =>
    mockOpenPlatformExportFolder(...args),
  loadLatestSourceExportPreview: (...args: unknown[]) =>
    mockLoadLatestSourceExportPreview(...args),
  loadLatestSourceExportFull: (...args: unknown[]) =>
    mockLoadLatestSourceExportFull(...args),
  loadSourceExportPreviewFromPath: (...args: unknown[]) =>
    mockLoadSourceExportPreviewFromPath(...args),
  loadSourceExportFullFromPath: (...args: unknown[]) =>
    mockLoadSourceExportFullFromPath(...args),
}))

vi.mock("@/lib/open-resource", () => ({
  openExportFolderPath: (...args: unknown[]) => mockOpenExportFolderPath(...args),
  toFileUrl: (path: string) => `file://${path}`,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockState = {
    app: {
      runs: [],
      platforms: [
        {
          id: "chatgpt-playwright",
          company: "OpenAI",
          name: "ChatGPT",
        },
      ],
    },
  }
  mockGetUserDataPath.mockResolvedValue("/tmp/dataconnect")
  mockLoadLatestSourceExportPreview.mockResolvedValue({
    previewJson: "{\n  \"ok\": true\n}",
    isTruncated: false,
    filePath: "/tmp/dataconnect/exported_data/OpenAI/ChatGPT/chatgpt.json",
    fileSizeBytes: 2048,
    exportedAt: "2026-02-11T10:00:00.000Z",
  })
  mockLoadLatestSourceExportFull.mockResolvedValue("{\"ok\":true}")
  mockLoadSourceExportPreviewFromPath.mockResolvedValue({
    previewJson: "{\n  \"from\": \"run\"\n}",
    isTruncated: false,
    filePath: "/tmp/dataconnect/exported_data/GitHub/GitHub/run-1/github.json",
    fileSizeBytes: 2048,
    exportedAt: "2026-02-11T10:00:00.000Z",
  })
  mockLoadSourceExportFullFromPath.mockResolvedValue("{\"from\":\"run\"}")
  mockOpenExportFolderPath.mockResolvedValue(true)
  mockOpenPlatformExportFolder.mockResolvedValue(undefined)
})

describe("useSourceOverviewPage", () => {
  it("uses the latest canonical source run's bounded export preview", async () => {
    mockState = {
      app: {
        runs: [
          {
            id: "github-pdpp-run",
            platformId: "github-pdpp",
            startDate: "2026-02-11T10:00:00.000Z",
            exportPath:
              "/tmp/dataconnect/exported_data/GitHub/GitHub/github-pdpp-run/github.json",
          },
        ],
        platforms: [
          { id: "github-playwright", company: "GitHub", name: "GitHub" },
          {
            id: "github-pdpp",
            company: "GitHub",
            name: "GitHub",
            runtime: "pdpp-network",
          },
        ],
      },
    }

    const { result } = renderHook(() => useSourceOverviewPage("github"))

    await waitFor(() => {
      expect(result.current.preview?.previewJson).toContain('"from": "run"')
    })
    expect(mockLoadSourceExportPreviewFromPath).toHaveBeenCalledWith(
      "/tmp/dataconnect/exported_data/GitHub/GitHub/github-pdpp-run/github.json"
    )
    expect(mockLoadLatestSourceExportPreview).not.toHaveBeenCalled()
    expect(result.current.sourcePlatform?.id).toBe("github-pdpp")

    await act(async () => {
      await result.current.handleCopyFullJson()
    })
    expect(mockLoadSourceExportFullFromPath).toHaveBeenCalledWith(
      "/tmp/dataconnect/exported_data/GitHub/GitHub/github-pdpp-run/github.json"
    )
  })

  it("falls back to local path open when platform folder open fails", async () => {
    mockLoadLatestSourceExportPreview.mockResolvedValue(null)
    mockOpenPlatformExportFolder.mockRejectedValue(new Error("open failed"))

    const { result } = renderHook(() => useSourceOverviewPage("chatgpt"))

    await waitFor(() => {
      expect(result.current.openSourcePath).toBeTruthy()
    })

    await act(async () => {
      await result.current.handleOpenSourcePath()
    })

    expect(mockOpenExportFolderPath).toHaveBeenCalled()
  })

  it("opens preview file directory directly when preview metadata exists", async () => {
    const { result } = renderHook(() => useSourceOverviewPage("chatgpt"))

    await waitFor(() => {
      expect(result.current.preview?.filePath).toContain("chatgpt.json")
    })

    await act(async () => {
      await result.current.handleOpenSourcePath()
    })

    expect(mockOpenExportFolderPath).toHaveBeenCalledWith(
      "/tmp/dataconnect/exported_data/OpenAI/ChatGPT/chatgpt.json"
    )
    expect(mockOpenPlatformExportFolder).not.toHaveBeenCalled()
  })

  it("loads preview/full export with ingest scope when available", async () => {
    const { result } = renderHook(() => useSourceOverviewPage("chatgpt"))

    await waitFor(() => {
      expect(result.current.sourceEntry?.id).toBe("chatgpt")
    })

    expect(mockLoadLatestSourceExportPreview).toHaveBeenCalledWith(
      "OpenAI",
      "ChatGPT",
      "chatgpt.conversations"
    )

    await act(async () => {
      await result.current.handleCopyFullJson()
    })

    expect(mockLoadLatestSourceExportFull).toHaveBeenCalledWith(
      "OpenAI",
      "ChatGPT",
      "chatgpt.conversations"
    )
  })

  it("sets copy status to error when clipboard copy fails", async () => {
    const consoleErrorSpy = silenceConsoleError()
    const originalClipboard = navigator.clipboard
    const originalExecCommand = document.execCommand

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")),
      },
    })
    document.execCommand = vi.fn(() => false)

    try {
      const { result } = renderHook(() => useSourceOverviewPage("chatgpt"))

      await waitFor(() => {
        expect(result.current.sourceEntry?.id).toBe("chatgpt")
      })

      await act(async () => {
        await result.current.handleCopyFullJson()
      })

      expect(result.current.copyStatus).toBe("error")
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to copy full JSON:",
        expect.any(Error)
      )
    } finally {
      consoleErrorSpy.mockRestore()
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      })
      document.execCommand = originalExecCommand
    }
  })

  it("copies fallback JSON when source platform is unavailable", async () => {
    mockState = {
      app: {
        runs: [],
        platforms: [],
      },
    }

    const originalClipboard = navigator.clipboard
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })

    try {
      const { result } = renderHook(() => useSourceOverviewPage("chatgpt"))

      await waitFor(() => {
        expect(result.current.sourcePlatform).toBe(null)
      })

      await act(async () => {
        await result.current.handleCopyFullJson()
      })

      expect(result.current.copyStatus).toBe("copied")
      expect(mockLoadLatestSourceExportFull).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      })
    }
  })

  it("falls back to preview JSON when full export load fails", async () => {
    const consoleErrorSpy = silenceConsoleError()
    mockLoadLatestSourceExportPreview.mockResolvedValue({
      previewJson: "{\n  \"from\": \"preview\"\n}",
      isTruncated: false,
      filePath: "/tmp/dataconnect/exported_data/OpenAI/ChatGPT/chatgpt.json",
      fileSizeBytes: 2048,
      exportedAt: "2026-02-11T10:00:00.000Z",
    })
    mockLoadLatestSourceExportFull.mockRejectedValue(new Error("parse failed"))

    const writeText = vi.fn().mockResolvedValue(undefined)
    const originalClipboard = navigator.clipboard
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })

    try {
      const { result } = renderHook(() => useSourceOverviewPage("chatgpt"))

      await waitFor(() => {
        expect(result.current.preview?.previewJson).toContain("\"from\": \"preview\"")
      })

      await act(async () => {
        await result.current.handleCopyFullJson()
      })

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to load full source export JSON:",
        expect.any(Error)
      )
      expect(writeText).toHaveBeenCalledWith("{\n  \"from\": \"preview\"\n}")
      expect(result.current.copyStatus).toBe("copied")
    } finally {
      consoleErrorSpy.mockRestore()
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      })
    }
  })

  it("resets copy status back to idle after feedback timeout", async () => {
    const originalClipboard = navigator.clipboard
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })

    try {
      const { result } = renderHook(() => useSourceOverviewPage("chatgpt"))

      await waitFor(() => {
        expect(result.current.sourceEntry?.id).toBe("chatgpt")
      })

      await act(async () => {
        await result.current.handleCopyFullJson()
      })

      expect(result.current.copyStatus).toBe("copied")

      await waitFor(
        () => {
          expect(result.current.copyStatus).toBe("idle")
        },
        { timeout: 2_500 }
      )
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      })
    }
  })

  it("suppresses preview error in non-tauri runtime", async () => {
    mockLoadLatestSourceExportPreview.mockRejectedValue(new Error("IPC unavailable"))

    const { result } = renderHook(() => useSourceOverviewPage("chatgpt"))

    await waitFor(() => {
      expect(result.current.isPreviewLoading).toBe(false)
    })

    expect(result.current.previewError).toBe(null)
    expect(result.current.preview).toBe(null)
  })

  it("surfaces preview error in tauri runtime", async () => {
    mockLoadLatestSourceExportPreview.mockRejectedValue(new Error("IPC unavailable"))

    const hadTauri = "__TAURI__" in window
    const previousTauri = (window as { __TAURI__?: unknown }).__TAURI__
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {},
    })

    try {
      const { result } = renderHook(() => useSourceOverviewPage("chatgpt"))

      await waitFor(() => {
        expect(result.current.isPreviewLoading).toBe(false)
      })

      expect(result.current.previewError).toBe("IPC unavailable")
      expect(result.current.preview).toBe(null)
    } finally {
      if (hadTauri) {
        Object.defineProperty(window, "__TAURI__", {
          configurable: true,
          value: previousTauri,
        })
      } else {
        delete (window as { __TAURI__?: unknown }).__TAURI__
      }
    }
  })

})
