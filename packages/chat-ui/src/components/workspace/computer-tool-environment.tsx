import {
  createContext,
  useContext,
  type PropsWithChildren,
} from "react";

export type ComputerToolEnvironment = {
  token?: string | undefined;
  runId?: string | undefined;
  machineName?: string | undefined;
  currentFrameId?: number | undefined;
  screenWidth?: number | undefined;
  screenHeight?: number | undefined;
  onOpenComputer?: (() => void) | undefined;
};

const ComputerToolEnvironmentContext = createContext<ComputerToolEnvironment>(
  {},
);

export function ComputerToolEnvironmentProvider({
  value,
  children,
}: PropsWithChildren<{ value: ComputerToolEnvironment }>) {
  return (
    <ComputerToolEnvironmentContext.Provider value={value}>
      {children}
    </ComputerToolEnvironmentContext.Provider>
  );
}

export const useComputerToolEnvironment = () =>
  useContext(ComputerToolEnvironmentContext);
