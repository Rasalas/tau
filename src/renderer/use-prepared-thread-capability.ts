import { useEffect, useRef, useState } from "react";
import type { PreparedThreadCapability } from "../shared/contracts";

type CapabilityReader = (cwd?: string) => Promise<PreparedThreadCapability>;

/** Reads capability for the currently selected prepared-thread project only. */
export function usePreparedThreadCapability(
  projectPath: string | undefined,
  readCapability: CapabilityReader | undefined,
): PreparedThreadCapability | undefined {
  const [capability, setCapability] = useState<PreparedThreadCapability>();
  const requestRef = useRef(0);
  const generationRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    // Generations are scoped to the prepared project. A project switch must
    // not let a higher generation from the old project reject a valid result.
    generationRef.current = 0;
    if (!projectPath || !readCapability) {
      setCapability(undefined);
      return;
    }
    setCapability(undefined);
    void readCapability(projectPath).then((next) => {
      if (
        request !== requestRef.current
        || next.cwd !== projectPath
        || next.generation < generationRef.current
      ) return;
      generationRef.current = next.generation;
      setCapability(next);
    }).catch(() => {
      if (request === requestRef.current) setCapability(undefined);
    });
  }, [projectPath, readCapability]);

  return capability;
}
