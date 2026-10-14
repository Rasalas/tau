// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_STAGE, type WorkspaceResourceOrigin } from "../workbench/stage";
import { useWorkspaceResourceNavigation } from "./workspace-resource-navigation";

afterEach(cleanup);

it.each([".scratch/report.md:12", "/main/.scratch/report.md:12"])("keeps the origin and source line when opening %s", (path) => {
  const reveal = vi.fn();
  const origin: WorkspaceResourceOrigin = { sessionId: "thread", workspace: "ws-tree", sourceId: "documents" };
  const { result } = renderHook(() => {
    const [stage, setStage] = useState(EMPTY_STAGE);
    const navigation = useWorkspaceResourceNavigation({ stage, setStage, workspace: "ws-tree", sourceId: "documents", reveal: useRef(reveal) });
    return { stage, ...navigation };
  });
  act(() => result.current.openWorkspaceFile(path, origin));
  expect(result.current.stage.tabs).toMatchObject([{ path: path.slice(0, -3), line: 12, resourceOrigin: origin }]);
  expect(reveal).toHaveBeenCalledOnce();
});
