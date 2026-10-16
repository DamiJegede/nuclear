import { useEffect } from "react";

export const APP_NAME = "Nuclear Admin";

/** Sets the browser tab title to "<page> · Nuclear Admin". `undefined` leaves the title alone (a child sets it). */
export function usePageTitle(page: string | null | undefined) {
  useEffect(() => {
    if (page === undefined) return;
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME;
  }, [page]);
}
