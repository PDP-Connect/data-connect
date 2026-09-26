// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { pdppCliConnectCommand, pdppCliTokenCompletionUnavailable } from "../pdpp-cli-command.ts";

const DATA_ACCESS_SKILL_NAME = "pdpp-data-access";
const DATA_ACCESS_SKILL_DESCRIPTION =
  "Use PDPP data through scoped client grants, project-local token caching, and capability-first querying instead of owner bearer tokens.";
const DATA_ACCESS_SKILL_BASE_REPO_PATH = "docs/agent-skills/pdpp-data-access";
const OWNER_AGENT_SKILL_NAME = "pdpp-owner-agent";
const OWNER_AGENT_SKILL_DESCRIPTION =
  "Use PDPP as trusted owner-level local automation through browser-mediated owner approval, local credential storage, and token-efficient REST sync.";
const OWNER_AGENT_SKILL_BASE_REPO_PATH = "docs/agent-skills/pdpp-owner-agent";
const WELL_KNOWN_BASE_PATH = "/.well-known/skills";
const OWNER_AGENT_SKILL_ROUTE_PATH = `${OWNER_AGENT_SKILL_NAME}/SKILL.md`;
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const MCP_ENDPOINT_PATH = "/mcp";
const LEADING_SLASHES = /^\/+/;

let cachedSkillRoot: string | null = null;

interface AgentSkillFileDefinition {
  readonly mediaType: string;
  readonly repoRelativePath: string;
  readonly routePath: string;
}

interface AgentSkillDefinition {
  readonly canonical_source: "docs/agent-skills";
  readonly description: string;
  readonly repoBasePath: string;
  readonly name: string;
  readonly recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog";
}

const SKILLS: readonly AgentSkillDefinition[] = [
  {
    canonical_source: "docs/agent-skills",
    description: DATA_ACCESS_SKILL_DESCRIPTION,
    repoBasePath: DATA_ACCESS_SKILL_BASE_REPO_PATH,
    name: DATA_ACCESS_SKILL_NAME,
    recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog",
  },
  {
    canonical_source: "docs/agent-skills",
    description: OWNER_AGENT_SKILL_DESCRIPTION,
    repoBasePath: OWNER_AGENT_SKILL_BASE_REPO_PATH,
    name: OWNER_AGENT_SKILL_NAME,
    recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog",
  },
];

let cachedSkillFiles: Promise<readonly AgentSkillFileDefinition[]> | null = null;

export interface AgentSkillCatalogFile {
  readonly bytes: number;
  readonly media_type: string;
  readonly path: string;
  readonly repo_path: string;
  readonly sha256: string;
  readonly url: string;
}

export interface AgentSkillCatalog {
  readonly object: "agent_skill_catalog";
  readonly skills: readonly AgentSkillCatalogSkill[];
  readonly version: "2026-04-26";
}

export interface AgentSkillCatalogSkill {
  readonly canonical_source: "docs/agent-skills";
  readonly description: string;
  readonly files: readonly AgentSkillCatalogFile[];
  readonly name: string;
  readonly recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog";
}

async function pathExists(absPath: string, kind: "file" | "dir"): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return kind === "file" ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
}

async function resolveSkillRoot(): Promise<string> {
  if (cachedSkillRoot) {
    return cachedSkillRoot;
  }

  const serverDirectory = path.dirname(process.argv[1] ?? process.cwd());
  const packagedRoots = [
    path.resolve(serverDirectory, "../../docs/agent-skills"),
    path.resolve(process.cwd(), "docs/agent-skills"),
  ];
  const packagedRootExists = await Promise.all(
    packagedRoots.map((root) => pathExists(path.join(root, "pdpp-data-access", "SKILL.md"), "file"))
  );
  const packagedRootIndex = packagedRootExists.findIndex(Boolean);
  if (packagedRootIndex !== -1) {
    const packagedRoot = packagedRoots[packagedRootIndex];
    if (packagedRoot) {
      cachedSkillRoot = packagedRoot;
      return packagedRoot;
    }
  }

  // Development runs from apps/console, while the canonical source lives at
  // the repository's docs/agent-skills path. Packaged production runs use one
  // of the stable roots above and do not need workspace or OpenSpec markers.
  if (process.env.NODE_ENV !== "production") {
    let dir = process.cwd();
    const { root } = path.parse(dir);
    const developmentRoots: string[] = [];
    for (;;) {
      developmentRoots.push(path.join(dir, "docs/agent-skills"));
      if (dir === root) {
        break;
      }
      dir = path.dirname(dir);
    }
    const developmentRootExists = await Promise.all(
      developmentRoots.map((skillRoot) => pathExists(path.join(skillRoot, "pdpp-data-access", "SKILL.md"), "file"))
    );
    const developmentRootIndex = developmentRootExists.findIndex(Boolean);
    if (developmentRootIndex !== -1) {
      const developmentRoot = developmentRoots[developmentRootIndex];
      if (developmentRoot) {
        cachedSkillRoot = developmentRoot;
        return developmentRoot;
      }
    }
  }

  throw new Error(`Could not resolve packaged agent skills from ${process.cwd()}`);
}

async function readSkillFile(repoRelativePath: string): Promise<Buffer> {
  const skillRoot = await resolveSkillRoot();
  return fs.readFile(path.join(skillRoot, path.relative("docs/agent-skills", repoRelativePath)));
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries: Dirent[] = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(entryPath);
      }
      return entry.isFile() ? [entryPath] : [];
    })
  );
  return nested.flat();
}

export async function resolveSkillDirectory(packagedRoot: string, skillName: string): Promise<string> {
  const skillPath = path.join(packagedRoot, skillName);
  const skillStat = await fs.lstat(skillPath);
  if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) {
    throw new Error(`Packaged agent skill root must be a real directory: ${skillName}`);
  }

  const [realPackagedRoot, realSkillPath] = await Promise.all([fs.realpath(packagedRoot), fs.realpath(skillPath)]);
  const relativeSkillPath = path.relative(realPackagedRoot, realSkillPath);
  if (
    !relativeSkillPath ||
    relativeSkillPath === ".." ||
    relativeSkillPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSkillPath)
  ) {
    throw new Error(`Packaged agent skill root escapes its packaged tree: ${skillName}`);
  }
  return realSkillPath;
}

async function skillFiles(): Promise<readonly AgentSkillFileDefinition[]> {
  if (!cachedSkillFiles) {
    cachedSkillFiles = (async () => {
      const skillRoot = await resolveSkillRoot();
      const definitions = await Promise.all(
        SKILLS.map(async (skill) => {
          const absoluteBase = await resolveSkillDirectory(skillRoot, skill.name);
          const absoluteFiles = (await collectFiles(absoluteBase)).sort();
          return absoluteFiles.map((absolutePath) => {
            const withinSkill = path.relative(absoluteBase, absolutePath).split(path.sep).join("/");
            return {
              mediaType:
                path.extname(absolutePath) === ".md" ? "text/markdown; charset=utf-8" : "application/octet-stream",
              repoRelativePath: path.posix.join(skill.repoBasePath, withinSkill),
              routePath: path.posix.join(skill.name, withinSkill),
            };
          });
        })
      );
      return definitions.flat();
    })();
  }
  return cachedSkillFiles;
}

function normalizeOrigin(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function catalogUrl(origin: string, routePath: string): string {
  return `${normalizeOrigin(origin)}${WELL_KNOWN_BASE_PATH}/${routePath}`;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function buildAgentSkillCatalog(origin: string): Promise<AgentSkillCatalog> {
  const allFiles = await skillFiles();
  const skills = await Promise.all(
    SKILLS.map(async (skill): Promise<AgentSkillCatalogSkill> => {
      const files = await Promise.all(
        allFiles
          .filter((file) => file.routePath.startsWith(`${skill.name}/`))
          .map(async (file): Promise<AgentSkillCatalogFile> => {
            const bytes = await readSkillFile(file.repoRelativePath);
            return {
              bytes: bytes.byteLength,
              media_type: file.mediaType,
              path: file.routePath,
              repo_path: file.repoRelativePath,
              sha256: sha256(bytes),
              url: catalogUrl(origin, file.routePath),
            };
          })
      );
      return {
        canonical_source: skill.canonical_source,
        description: skill.description,
        files,
        name: skill.name,
        recommended_install: skill.recommended_install,
      };
    })
  );

  return {
    object: "agent_skill_catalog",
    skills,
    version: "2026-04-26",
  };
}

export async function readAgentSkillFile(routePath: string): Promise<{
  readonly body: Buffer;
  readonly definition: AgentSkillFileDefinition;
} | null> {
  const normalized = routePath.replace(LEADING_SLASHES, "");
  const definition = (await skillFiles()).find((file) => file.routePath === normalized);
  if (!definition) {
    return null;
  }
  return {
    body: await readSkillFile(definition.repoRelativePath),
    definition,
  };
}

export function ownerAgentOnboardingLLMSIndex(): string {
  return [
    "## Trusted owner-agent onboarding (owner-level local automation)",
    "",
    "Only for a local agent the operator has explicitly authorized to act as themselves (e.g. a local assistant such as Daisy). Routine third-party, coding-agent, and task-scoped assistants are NOT this profile - they use the grant-scoped `pdpp-data-access` skill above.",
    "",
    `- Canonical onboarding metadata: ${PROTECTED_RESOURCE_METADATA_PATH} on this operator origin. When owner-agent onboarding is enabled, the \`pdpp_owner_agent_onboarding\` advisory block names every surface (owner approval / device authorization, token, schema, streams, query base, introspection, revocation, event subscriptions).`,
    `- Owner-agent onboarding guidance: ${WELL_KNOWN_BASE_PATH}/${OWNER_AGENT_SKILL_ROUTE_PATH}`,
    `- Grant-scoped MCP (ordinary external clients, not owner agents): ${MCP_ENDPOINT_PATH} - \`/mcp\` rejects owner bearers by design.`,
    "- REST/CLI owner-agent guidance: use the owner bearer only on owner-supported `/v1/**` REST routes; the `pdpp owner-agent onboard <entrypoint>` CLI runs the browser-mediated flow without printing the bearer.",
    "",
    "Do not paste tokens. Owner approval happens in a browser-mediated owner-console flow; the credential is written to a local credential target. Never ask the operator to paste a bearer into chat or a terminal, and never echo or log the bearer.",
  ].join("\n");
}

export function agentSkillsLLMSIndex(): string {
  return [
    "## Agent Skills",
    "",
    `- ${DATA_ACCESS_SKILL_NAME}: ${WELL_KNOWN_BASE_PATH}/${DATA_ACCESS_SKILL_NAME}/SKILL.md`,
    `- ${OWNER_AGENT_SKILL_NAME}: ${WELL_KNOWN_BASE_PATH}/${OWNER_AGENT_SKILL_ROUTE_PATH}`,
    `- Skill catalog: ${WELL_KNOWN_BASE_PATH}/index.json`,
    `- PDPP CLI connect command: \`${pdppCliConnectCommand}\``,
    "",
    `Use the skill when a coding agent needs PDPP data through scoped client grants. The skill is CLI-first and forbids owner-token use for routine data access. Token completion is ${
      pdppCliTokenCompletionUnavailable ? "not yet public; keep the CLI command gated." : "available through the CLI."
    }`,
    "",
    ownerAgentOnboardingLLMSIndex(),
  ].join("\n");
}

export async function agentSkillsLLMSFullText(): Promise<string> {
  const allFiles = await skillFiles();
  const parts = await Promise.all(
    allFiles.map(async (file) => {
      const body = await readSkillFile(file.repoRelativePath);
      return [`## ${file.repoRelativePath}`, "", body.toString("utf8")].join("\n");
    })
  );
  return ["# Agent Skills", "", ...parts].join("\n\n");
}
