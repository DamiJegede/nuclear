import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

afterEach(() => vi.restoreAllMocks());

describe("CopyButton", () => {
  it("copies the value, says Copied, then goes back to Copy", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<CopyButton value="secret-value" resetMs={60} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith("secret-value");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument());
  });

  it("says Copy Failed when the clipboard is unavailable", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<CopyButton value="x" resetMs={60} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copy Failed" })).toBeInTheDocument();
  });
});
