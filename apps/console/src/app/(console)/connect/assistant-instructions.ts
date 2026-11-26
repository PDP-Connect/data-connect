// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
/** Menu names checked against the linked first-party help on the stated date. */
export const assistantInstructions = [
  {
    name: "ChatGPT",
    checkedAt: "2026-11-26",
    help: "https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta",
    steps: [
      "Open “Plugins”, press “+”, then choose “Add custom MCP server”.",
      "Give it a name and paste the address above. Review its sign-in choice and the risk acknowledgment, then choose “Create as a plugin”.",
      "In a new chat, use @ to choose it.",
    ],
  },
  {
    name: "Claude",
    checkedAt: "2026-11-26",
    help: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    steps: [
      "Open “Customize”, then “Connectors”, then “Add custom connector”.",
      "Give it a name and paste the address above. Review its sign-in choice, add it and connect.",
      "In a chat, press “+”, then “Connectors”, to turn it on.",
    ],
  },
  {
    name: "Claude Code",
    checkedAt: "2026-11-25",
    help: "https://code.claude.com/docs/en/mcp",
    steps: ["Run the command below in your terminal, then open Claude Code and use “/mcp” to sign in."],
  },
  {
    name: "Another app",
    checkedAt: "2026-11-25",
    help: null,
    steps: ["Give the app the address above. Follow its help page to add a remote server."],
  },
] as const;

/** Matches the existing technical setup command; quote the address for a shell. */
export function claudeCodeCommand(origin: string): string {
  const address = `${origin.replace(/\/+$/, "")}/mcp`;
  return `claude mcp add --transport http dataconnect '${address.replaceAll("'", "'\\''")}'`;
}
