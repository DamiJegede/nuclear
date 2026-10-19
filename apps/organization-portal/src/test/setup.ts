import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { clearCache } from "../cache";

afterEach(() => {
  cleanup();
  clearCache();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
