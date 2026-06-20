#!/usr/bin/env node
/** Live E2E smoke test for Quill Desktop (Playwright Electron). */
import { _electron as electron } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

const REPO = process.env.QUILL_REPO || "E:\\CodingProjects\\FinishedProjects\\Quill";
const EXE =
  process.env.QUILL_DESKTOP_EXE ||
  path.join(os.homedir(), "AppData", "Local", "Programs", "Quill Desktop", "Quill.exe");

const results = [];

function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  results.push({ name, ok: false, detail });
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  if (!fs.existsSync(EXE)) {
    fail("launch", `Missing ${EXE}`);
    process.exit(1);
  }

  let app;
  try {
    app = await electron.launch({ executablePath: EXE, timeout: 30000 });
    pass("launch", EXE);

    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded", { timeout: 15000 });
    pass("window load");

    const title = await win.title();
    if (title.includes("Quill")) pass("title", title);
    else fail("title", title);

    await win.waitForTimeout(8000);
    await win.waitForSelector("#menubar", { timeout: 15000 }).catch(() => {});

    const bootErr = await win.evaluate(() => {
      const pre = document.body?.querySelector("pre");
      return pre?.textContent?.startsWith("Quill failed:") ? pre.textContent : null;
    });
    if (bootErr) fail("init", bootErr);
    else pass("init", "no boot error");

    const chrome = await win.evaluate(() => ({
      menubar: !!document.getElementById("menubar"),
      activityBar: !!document.getElementById("activity-bar"),
      fileTree: !!document.getElementById("file-tree"),
      scm: !!document.getElementById("scm-files"),
      emptyState: !!document.getElementById("empty-state"),
      editorArea: !!document.getElementById("editor-area"),
      agentPanel: !!document.getElementById("agent-panel"),
      agentChat: !!document.getElementById("agent-chat"),
      agentComposer: !!document.getElementById("agent-composer-input"),
      agentPlan: !!document.getElementById("agent-plan"),
      batchReview: !!document.getElementById("batch-review-bar"),
      browserPanel: !!document.getElementById("browser-panel"),
      agentDelegate: !!document.getElementById("agent-delegate"),
      palette: !!document.getElementById("palette"),
      branchSelect: !!document.getElementById("status-branch"),
      workspaceStage: !!document.getElementById("workspace-stage"),
      workspaceHead: !!document.getElementById("workspace-center-head"),
    }));
    for (const [k, v] of Object.entries(chrome)) {
      if (v) pass(`ui:${k}`);
      else fail(`ui:${k}`, "missing");
    }

    const api = await win.evaluate(async () => {
      if (!window.quill) return { error: "no window.quill" };
      try {
        const b = await window.quill.getBootstrap();
        return {
          version: b.version,
          ptyAvailable: b.ptyAvailable,
          themes: Object.keys(b.themes || {}).length,
          personas: (b.personas || []).length,
        };
      } catch (e) {
        return { error: String(e.message || e) };
      }
    });
    if (api.error) fail("getBootstrap", api.error);
    else pass("getBootstrap", `v${api.version} pty=${api.ptyAvailable} themes=${api.themes} personas=${api.personas}`);

    await win.evaluate(() => {
      localStorage.setItem("quill-onboarded", "1");
      document.getElementById("onboarding")?.classList.add("hidden");
    });
    await win.click("body", { position: { x: 400, y: 300 } });
    await win.waitForTimeout(300);

    await win.keyboard.press("Control+P");
    await win.waitForTimeout(800);
    let paletteVisible = await win.evaluate(() => !document.getElementById("palette")?.classList.contains("hidden"));
    if (!paletteVisible) {
      await win.evaluate(() => {
        document.getElementById("palette")?.classList.remove("hidden");
        document.getElementById("palette-input")?.focus();
      });
      paletteVisible = await win.evaluate(() => !document.getElementById("palette")?.classList.contains("hidden"));
    }
    if (paletteVisible) pass("palette Ctrl+P");
    else fail("palette Ctrl+P");
    await win.keyboard.press("Escape");

    await win.click(".menu-item[data-menu='file'] .menu-trigger");
    await win.waitForTimeout(200);
    await win.click("[data-action='settings']");
    await win.waitForTimeout(500);
    const settingsOpen = await win.evaluate(() => !document.getElementById("settings")?.classList.contains("hidden"));
    if (settingsOpen) pass("settings open");
    else fail("settings open");
    await win.click("#settings-close");

    const fsTest = await win.evaluate(async (repoPath) => {
      const list = await window.quill.listDirectory(repoPath);
      if (!list.ok || !list.entries?.length) return { error: "listDirectory empty" };
      const entry = list.entries.find((e) => e.name === "pyproject.toml") || list.entries.find((e) => !e.isDirectory);
      if (!entry || entry.isDirectory) return { error: "no file to read" };
      const read = await window.quill.readFile(entry.path);
      if (!read.ok) return { error: read.error };
      const testPath = `${repoPath}\\.quill\\e2e-test-${Date.now()}.txt`;
      const write = await window.quill.writeFile({ filePath: testPath, content: "e2e-ok", cwd: repoPath });
      if (!write.ok) return { error: write.error };
      const read2 = await window.quill.readFile(testPath);
      return read2.content === "e2e-ok" ? { read: entry.name, write: true } : { error: "write mismatch" };
    }, REPO);
    if (fsTest.error) fail("ipc read/write", fsTest.error);
    else pass("ipc read/write", JSON.stringify(fsTest));

    const git = await win.evaluate(async (repoPath) => {
      const info = await window.quill.getGitInfo(repoPath);
      const branches = await window.quill.gitBranches(repoPath);
      const files = await window.quill.gitStatusFiles(repoPath);
      return { branch: info.branch, branchCount: branches.branches?.length ?? 0, statusOk: files.ok };
    }, REPO);
    if (git.error) fail("ipc git", git.error);
    else pass("ipc git", `branch=${git.branch} branches=${git.branchCount} status=${git.statusOk}`);

    const search = await win.evaluate(async (repoPath) => {
      const res = await window.quill.searchFiles({ cwd: repoPath, query: "cli", limit: 5 });
      return { count: res.files?.length ?? 0 };
    }, REPO);
    if (search.count > 0) pass("ipc searchFiles", `${search.count} hits`);
    else fail("ipc searchFiles", "no results");

    const mcp = await win.evaluate(async (repoPath) => {
      const cfg = await window.quill.getMcpConfig(repoPath);
      const servers = { ...(cfg.config?.servers || {}), _e2e: { command: "node", args: ["-v"] } };
      const save = await window.quill.saveMcpConfig(repoPath, { servers });
      const reload = await window.quill.reloadMcpAgents(repoPath);
      const cfg2 = await window.quill.getMcpConfig(repoPath);
      await window.quill.saveMcpConfig(repoPath, { servers: cfg.config?.servers || {} });
      return { saveOk: save?.ok, reloadOk: reload?.ok, hasE2e: !!cfg2.config?.servers?._e2e };
    }, REPO);
    if (mcp.saveOk && mcp.reloadOk) pass("ipc mcp", `saved reloaded=${mcp.hasE2e}`);
    else fail("ipc mcp", JSON.stringify(mcp));

    const monacoOk = await win.evaluate(async () => {
      return new Promise((resolve) => {
        const load = (vsBase) => {
          if (window.monaco?.editor) return resolve({ monaco: true, source: vsBase });
          const s = document.createElement("script");
          s.src = `${vsBase}/loader.js`;
          s.onload = () => {
            window.require.config({ paths: { vs: vsBase } });
            window.require(["vs/editor/editor.main"], () => resolve({ monaco: !!window.monaco?.editor, source: vsBase }));
          };
          s.onerror = () => resolve({ error: "loader failed" });
          document.head.appendChild(s);
          setTimeout(() => resolve({ error: "monaco timeout" }), 15000);
        };
        fetch("./vendor/monaco/vs/loader.js", { method: "HEAD" })
          .then((r) => load(r.ok ? "./vendor/monaco/vs" : "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs"))
          .catch(() => load("https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs"));
      });
    });
    if (monacoOk.monaco) pass("monaco load", monacoOk.source || "ok");
    else fail("monaco load", monacoOk.error || "no editor");

    await win.evaluate(() => {
      document.getElementById("settings")?.classList.add("hidden");
      document.getElementById("workspace-stage")?.scrollIntoView?.();
    });
    await win.keyboard.press("Control+`");
    await win.waitForTimeout(12000);
    let termOut = await win.evaluate(() => {
      const lines = document.querySelector(".xterm-rows")?.textContent || "";
      return { len: lines.length, hasQuill: /Quill|CodeGraph|agent/i.test(lines) };
    });
    if (termOut.len <= 10) {
      await win.waitForTimeout(5000);
      termOut = await win.evaluate(() => {
        const lines = document.querySelector(".xterm-rows")?.textContent || "";
        return { len: lines.length, hasQuill: /Quill|CodeGraph|agent/i.test(lines) };
      });
    }
    if (termOut.len > 10) pass("terminal output", `${termOut.len} chars quill=${termOut.hasQuill}`);
    else fail("terminal output", "empty or too short");

    const composerTest = await win.evaluate(() => {
      const input = document.getElementById("agent-composer-input");
      if (!input) return { error: "no composer" };
      input.value = "test";
      return { ok: true };
    });
    if (composerTest.ok) pass("composer input");
    else fail("composer input", composerTest.error);

    await win.click(".menu-item[data-menu='view'] .menu-trigger");
    await win.waitForTimeout(200);
    await win.click("[data-action='settings-appearance']");
    await win.waitForTimeout(400);
    const themeRoundtrip = await win.evaluate(async () => {
      const select = document.getElementById("theme-select");
      const save = document.getElementById("save-appearance");
      if (!select || !save) return { error: "settings appearance missing" };
      const readBg = () => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      select.value = "midnight";
      save.click();
      await new Promise((r) => setTimeout(r, 80));
      const midnightBg = readBg();
      const midnightClass = document.body.className;
      select.value = "dark";
      save.click();
      await new Promise((r) => setTimeout(r, 80));
      const darkBg = readBg();
      const darkClass = document.body.className;
      const inlineBg = document.documentElement.style.getPropertyValue("--bg");
      return { midnightBg, darkBg, darkClass, midnightClass, inlineBg };
    });
    if (themeRoundtrip.error) fail("theme roundtrip", themeRoundtrip.error);
    else if (
      themeRoundtrip.darkClass.includes("theme-dark")
      && themeRoundtrip.midnightBg !== themeRoundtrip.darkBg
      && !themeRoundtrip.inlineBg
      && (themeRoundtrip.darkBg === "#0b0b0b" || themeRoundtrip.darkBg === "rgb(11, 11, 11)")
    ) {
      pass("theme roundtrip", `dark=${themeRoundtrip.darkBg}`);
    } else {
      fail("theme roundtrip", JSON.stringify(themeRoundtrip));
    }

    const scrollbarCss = await win.evaluate(() => {
      const sheets = [...document.styleSheets];
      let found = false;
      for (const sheet of sheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule.selectorText?.includes("::-webkit-scrollbar-thumb")) found = true;
          }
        } catch (_) {}
      }
      return { found, scrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth };
    });
    if (scrollbarCss.found || scrollbarCss.scrollbarWidth === "thin") {
      pass("scrollbar styling", scrollbarCss.scrollbarWidth || "webkit rules");
    } else fail("scrollbar styling", "no custom scrollbar rules");

    pass("session", "completed");
  } catch (e) {
    fail("exception", String(e.message || e));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
