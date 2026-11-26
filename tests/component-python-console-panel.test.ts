import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

const { PythonConsolePanel } =
  await import("../apps/geolibre-desktop/src/components/panels/PythonConsolePanel");
type Runtime =
  import("../apps/geolibre-desktop/src/components/panels/PythonConsolePanel").PythonConsoleRuntime;

/** A console runtime that echoes code, fails on `boom`, and can hold its start. */
function fakeRuntime(options: { initFails?: string; manualStart?: boolean } = {}) {
  const ran: string[] = [];
  let progress: ((phase: string) => void) | null = null;
  let start!: () => void;
  const started = new Promise<void>((resolve) => (start = resolve));
  if (!options.manualStart) start();
  const runtime: Runtime = {
    consoleDeps: (getController) => ({ getController }),
    onConsoleProgress: (listener) => {
      progress = listener;
      return () => {
        progress = null;
      };
    },
    initConsoleRuntime: async () => {
      await started;
      if (options.initFails) throw new Error(options.initFails);
      // The panel only awaits start-up; it never touches the runtime object.
      return {} as Awaited<ReturnType<Runtime["initConsoleRuntime"]>>;
    },
    runConsoleCode: async (_deps, source) => {
      ran.push(source);
      if (source.includes("boom"))
        return { output: "", error: "NameError: name 'boom' is not defined" };
      return { output: `>> ${source}`, error: "" };
    },
  };
  return { runtime, ran, start, emitProgress: (phase: string) => progress?.(phase) };
}

function renderConsole(runtime: Runtime) {
  return render(
    createElement(PythonConsolePanel, { mapControllerRef: { current: null }, runtime }),
  );
}

const input = () => screen.getByPlaceholderText(/Python here/) as HTMLTextAreaElement;
const text = () => document.body.textContent ?? "";
/** Whether an output entry reads exactly `line`, so the echoed input cannot match. */
const hasOutput = (line: string) => screen.queryAllByText(line, { exact: true }).length > 0;

/** Wait until Run is enabled for typed code, which needs a started runtime. */
async function ready() {
  fireEvent.change(input(), { target: { value: "pass" } });
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled"), false),
  );
  fireEvent.change(input(), { target: { value: "" } });
}

function submit(code: string) {
  fireEvent.change(input(), { target: { value: code } });
  fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
}

describe("PythonConsolePanel", () => {
  it("shows load progress, then runs code once the runtime is ready", async () => {
    const { runtime, ran, start, emitProgress } = fakeRuntime({ manualStart: true });
    renderConsole(runtime);
    act(() => emitProgress("Loading Pyodide…"));
    assert.ok(text().includes("Loading Pyodide…"));
    fireEvent.change(input(), { target: { value: "pass" } });
    assert.equal(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled"), true);
    act(() => start());
    await ready();
    assert.ok(!text().includes("Loading Pyodide…"));

    submit("  geolibre.get_center()  ");
    await waitFor(() => assert.ok(hasOutput(">> geolibre.get_center()")));
    assert.deepEqual(ran, ["geolibre.get_center()"]);
    assert.equal(input().value, "");
  });

  it("prints a Python error in the output", async () => {
    const { runtime } = fakeRuntime();
    renderConsole(runtime);
    await ready();
    submit("boom");
    await waitFor(() => assert.ok(text().includes("NameError: name 'boom' is not defined")));
  });

  it("recalls earlier commands with the arrow keys and restores the draft", async () => {
    const { runtime } = fakeRuntime();
    renderConsole(runtime);
    await ready();
    submit("a = 1");
    await waitFor(() => assert.ok(hasOutput(">> a = 1")));
    submit("b = 2");
    await waitFor(() => assert.ok(hasOutput(">> b = 2")));
    fireEvent.change(input(), { target: { value: "draft" } });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    assert.equal(input().value, "b = 2");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    assert.equal(input().value, "a = 1");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    assert.equal(input().value, "b = 2");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    assert.equal(input().value, "draft");
  });

  it("reports a runtime that fails to load", async () => {
    const { runtime } = fakeRuntime({ initFails: "Pyodide download failed" });
    renderConsole(runtime);
    await waitFor(() => assert.ok(text().includes("Pyodide download failed")));
    assert.equal(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled"), true);
  });

  it("clears the output and closes", async () => {
    act(() => useAppStore.getState().setPythonConsoleOpen(true));
    const { runtime } = fakeRuntime();
    renderConsole(runtime);
    await ready();
    submit("x = 3");
    await waitFor(() => assert.ok(hasOutput(">> x = 3")));
    fireEvent.click(screen.getByTitle("Clear output"));
    assert.ok(!hasOutput(">> x = 3"));
    fireEvent.click(screen.getByTitle("Close Python console"));
    assert.equal(useAppStore.getState().ui.pythonConsoleOpen, false);
  });

  it("runs a script from the editor pane with a marker line", async () => {
    const { runtime, ran } = fakeRuntime();
    renderConsole(runtime);
    await ready();
    fireEvent.click(screen.getByTitle("Show editor"));
    const editor = screen.getByPlaceholderText(
      /Write a multi-line Python script/,
    ) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "for i in range(2):\n    print(i)" } });
    fireEvent.click(screen.getByTitle(/Run script or selection/));
    await waitFor(() => assert.equal(ran.length, 1));
    assert.equal(ran[0], "for i in range(2):\n    print(i)");
    assert.ok(text().includes("# ▶ untitled.py"));
  });
});
