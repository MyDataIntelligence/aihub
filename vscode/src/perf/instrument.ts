import { perfEvent, span } from "./probe";

export type Api = { commands: { registerCommand: (...a: any[]) => { dispose(): unknown } }; window: Record<string, unknown> };

/** Wraps registerCommand and the show*Message calls of this extension's API object; false when it cannot be changed. */
export function instrumentApi(api: Api): { commands: boolean; notifications: boolean } {
  const swap = (obj: Record<string, unknown>, key: string, make: (orig: (...a: any[]) => any) => (...a: any[]) => any) => {
    try {
      const orig = obj[key];
      if (typeof orig !== "function" || (orig as { __aihubPerf?: boolean }).__aihubPerf) return typeof orig === "function";
      const w = Object.assign(make((orig as (...a: any[]) => any).bind(obj)), { __aihubPerf: true });
      obj[key] = w;
      return obj[key] === w;
    } catch {
      return false;
    }
  };
  const commands = swap(api.commands as unknown as Record<string, unknown>, "registerCommand", (orig) => (id: string, cb: (...a: any[]) => any, thisArg?: unknown) =>
    orig(id, (...a: any[]) => {
      const end = span("cmd", id);
      try {
        const r = cb.apply(thisArg, a);
        if (r && typeof r.then === "function")
          return r.then(
            (v: unknown) => (end(true), v),
            (e: unknown) => {
              end(false);
              throw e;
            },
          );
        end(true);
        return r;
      } catch (e) {
        end(false);
        throw e;
      }
    }),
  );
  let notifications = true;
  for (const [key, level] of [
    ["showInformationMessage", "info"],
    ["showWarningMessage", "warning"],
    ["showErrorMessage", "error"],
  ] as const)
    notifications =
      swap(api.window, key, (orig) => (message: unknown, ...rest: unknown[]) => {
        const opts = rest[0] && typeof rest[0] === "object" ? (rest[0] as { modal?: boolean }) : undefined;
        perfEvent("notify", { level, text: String(message ?? "").split(/\r?\n/)[0].slice(0, 120), modal: opts?.modal || undefined });
        return orig(message, ...rest);
      }) && notifications;
  return { commands, notifications };
}
