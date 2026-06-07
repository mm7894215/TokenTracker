import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../lib/copy";
import {
  addSkillRepo,
  deleteLocalSkill,
  discoverSkills,
  getInstalledSkills,
  getSkillRepos,
  importLocalSkill,
  installSkill,
  removeSkillRepo,
  restoreSkill,
  searchSkills,
  setSkillTargets,
  uninstallSkill,
} from "../lib/skills-api";
import { SkillsPage } from "./SkillsPage.jsx";

vi.mock("../lib/skills-api", () => ({
  addSkillRepo: vi.fn(),
  deleteLocalSkill: vi.fn(),
  discoverSkills: vi.fn(),
  getInstalledSkills: vi.fn(),
  getSkillRepos: vi.fn(),
  importLocalSkill: vi.fn(),
  installSkill: vi.fn(),
  removeSkillRepo: vi.fn(),
  restoreSkill: vi.fn(),
  searchSkills: vi.fn(),
  setSkillTargets: vi.fn(),
  uninstallSkill: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getInstalledSkills).mockResolvedValue({
    targets: [
      { id: "claude", label: "Claude" },
      { id: "grok", label: "Grok" },
      { id: "antigravity", label: "Antigravity" },
    ],
    skills: [
      {
        id: "alpha-skill",
        name: "Alpha Skill",
        directory: "alpha-skill",
        description: "First installed skill.",
        targets: ["claude", "grok", "antigravity"],
        managed: true,
      },
      {
        id: "beta-skill",
        name: "Beta Skill",
        directory: "beta-skill",
        description: "Second installed skill.",
        targets: ["claude"],
        managed: true,
      },
    ],
  });
  vi.mocked(getSkillRepos).mockResolvedValue({ repos: [] });
  vi.mocked(discoverSkills).mockResolvedValue({ skills: [] });
  vi.mocked(searchSkills).mockResolvedValue({ skills: [] });
  vi.mocked(installSkill).mockResolvedValue({ ok: true });
  vi.mocked(uninstallSkill).mockResolvedValue({ ok: true });
  vi.mocked(restoreSkill).mockResolvedValue({ ok: true });
  vi.mocked(setSkillTargets).mockResolvedValue({ ok: true });
  vi.mocked(importLocalSkill).mockResolvedValue({ ok: true });
  vi.mocked(deleteLocalSkill).mockResolvedValue({ ok: true });
  vi.mocked(addSkillRepo).mockResolvedValue({ ok: true });
  vi.mocked(removeSkillRepo).mockResolvedValue({ ok: true });
});

describe("SkillsPage", () => {
  it("renders installed skills instead of the empty state", async () => {
    render(<SkillsPage />);

    expect(await screen.findByText("Alpha Skill")).toBeInTheDocument();
    expect(screen.getByText("Beta Skill")).toBeInTheDocument();
    expect(screen.getByText("First installed skill.")).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: copy("skills.action.search_aria") }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText(copy("skills.empty.my"))).not.toBeInTheDocument();
    });
  });

  it("filters the My tab list client-side by search query", async () => {
    const user = userEvent.setup();
    render(<SkillsPage />);

    expect(await screen.findByText("Alpha Skill")).toBeInTheDocument();
    expect(screen.getByText("Beta Skill")).toBeInTheDocument();

    const searchInput = screen.getByRole("searchbox", {
      name: copy("skills.action.search_aria"),
    });
    await user.type(searchInput, "alpha");

    await waitFor(() => {
      expect(screen.getByText("Alpha Skill")).toBeInTheDocument();
      expect(screen.queryByText("Beta Skill")).not.toBeInTheDocument();
    });
    expect(searchSkills).not.toHaveBeenCalled();
  });

  it("clears My tab search when clear search is clicked", async () => {
    const user = userEvent.setup();
    render(<SkillsPage />);

    expect(await screen.findByText("Alpha Skill")).toBeInTheDocument();

    const searchInput = screen.getByRole("searchbox", {
      name: copy("skills.action.search_aria"),
    });
    await user.type(searchInput, "alpha");

    await waitFor(() => {
      expect(screen.queryByText("Beta Skill")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: copy("skills.action.search_clear") }));

    await waitFor(() => {
      expect(screen.getByText("Beta Skill")).toBeInTheDocument();
      expect(searchInput).toHaveValue("");
    });
  });

  it("does not mark an unrelated browse skill installed when only the nested local leaf matches", async () => {
    const user = userEvent.setup();
    vi.mocked(getInstalledSkills).mockResolvedValue({
      targets: [
        { id: "claude", label: "Claude" },
        { id: "codex", label: "Codex" },
      ],
      skills: [
        {
          id: "local:apple/apple-notes",
          name: "Local Apple Notes",
          directory: "apple/apple-notes",
          description: "Nested local skill.",
          targets: ["claude"],
          managed: true,
        },
      ],
    });
    vi.mocked(getSkillRepos).mockResolvedValue({
      repos: [{ owner: "someone", name: "unrelated-skills", branch: "main", enabled: true }],
    });
    vi.mocked(discoverSkills).mockResolvedValue({
      skills: [
        {
          key: "someone/unrelated-skills:apple-notes",
          name: "Remote Apple Notes",
          directory: "apple-notes",
          description: "Different remote skill with the same leaf name.",
          repoOwner: "someone",
          repoName: "unrelated-skills",
          repoBranch: "main",
        },
      ],
    });

    render(<SkillsPage />);

    expect(await screen.findByText("Local Apple Notes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy("skills.tab.browse") }));

    expect(await screen.findByText("Remote Apple Notes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy("skills.action.install") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy("skills.card.manage") })).not.toBeInTheDocument();
  });
});
